package com.fitmotion.app;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import android.os.SystemClock;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * 把整段 16-bit PCM 编成 AAC，并与已编码好的无声 MP4 混流。
 *
 * 视频轨不重编码：MediaExtractor 直接拷贝样本，只是换个容器写出来；
 * 音频轨用 MediaCodec 硬编 AAC-LC（128 kbps），按 1024 样本一帧喂入。
 * 整个过程只有一次编码，成本大约是视频渲染的零头。
 */
final class AudioMixer {

    private static final int AAC_BITRATE = 128_000;
    private static final int AAC_FRAME_SAMPLES = 1024;
    /** 成片时长与源视频允许的偏差；超过说明混流把时间轴搞坏了。 */
    private static final long DURATION_TOLERANCE_MS = 400;

    static final class Result {
        final long mixMs;
        final long audioTrackMs;
        final long outMs;

        Result(long mixMs, long audioTrackMs, long outMs) {
            this.mixMs = mixMs;
            this.audioTrackMs = audioTrackMs;
            this.outMs = outMs;
        }
    }

    /**
     * @param videoIn    无声 MP4（H.264，已编码完成）
     * @param pcm        交织的 16-bit 小端 PCM
     * @param sampleRate 采样率（JS 侧固定 44100）
     * @param channels   声道数（1 或 2）
     * @param out        输出 MP4
     * @return 混流耗时与最终时长，失败抛异常
     */
    static Result mux(File videoIn, byte[] pcm, int sampleRate, int channels, File out) throws Exception {
        long started = SystemClock.elapsedRealtime();
        MediaExtractor extractor = null;
        MediaCodec audioEncoder = null;
        MediaMuxer muxer = null;
        try {
            if (out.exists()) out.delete();

            // 1) 找到视频轨，拿到格式
            extractor = new MediaExtractor();
            extractor.setDataSource(videoIn.getAbsolutePath());
            int videoTrack = -1;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    videoTrack = i;
                    break;
                }
            }
            if (videoTrack < 0) throw new IOException("源视频没有视频轨");
            extractor.selectTrack(videoTrack);
            MediaFormat videoFormat = extractor.getTrackFormat(videoTrack);
            long videoDurationUs = videoFormat.containsKey(MediaFormat.KEY_DURATION)
                    ? videoFormat.getLong(MediaFormat.KEY_DURATION) : 0;

            // 2) AAC 编码器（不给 Surface，纯 ByteBuffer 模式）
            audioEncoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            MediaFormat audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels);
            audioFormat.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            audioFormat.setInteger(MediaFormat.KEY_BIT_RATE, AAC_BITRATE);
            audioFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, AAC_FRAME_SAMPLES * channels * 2 * 4);
            audioEncoder.configure(audioFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            audioEncoder.start();

            muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int muxVideoTrack = muxer.addTrack(videoFormat);

            // 3) 先跑音频编码器直到输出格式确定，拿到编码后参数（含 csd-0）
            //    再把音视频两轨都注册好之后才能 start()
            int muxAudioTrack = -1;
            boolean muxerStarted = false;
            long audioDurationUs = computeDurationUs(pcm.length, sampleRate, channels);
            boolean inputDone = false;
            boolean outputDone = false;
            int inputOffset = 0;
            // 已喂入的「采样数」（不是帧数）：AAC 的 PTS 必须以采样数为基准换算，
            // 乘上每帧样本数会让时间轴平方级膨胀（37 秒的片子变成十几小时）。
            long samplesFed = 0;
            long lastAudioPtsUs = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = System.currentTimeMillis() + 60_000;

            // 4) 音频编码主循环：入队 PCM，出队 AAC，格式确定后启动 muxer
            while (!outputDone && System.currentTimeMillis() < deadline) {
                if (!inputDone) {
                    int inIndex = audioEncoder.dequeueInputBuffer(10_000);
                    if (inIndex >= 0) {
                        ByteBuffer in = audioEncoder.getInputBuffer(inIndex);
                        if (in == null) throw new IOException("拿不到音频输入缓冲");
                        in.clear();
                        int frameBytes = AAC_FRAME_SAMPLES * channels * 2;
                        int chunk = Math.min(frameBytes, pcm.length - inputOffset);
                        if (chunk <= 0) {
                            audioEncoder.queueInputBuffer(inIndex, 0, 0, lastAudioPtsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            in.put(pcm, inputOffset, chunk);
                            // 末帧不足 1024 样本：静音补齐
                            for (int pad = chunk; pad < frameBytes; pad++) in.put((byte) 0);
                            long ptsUs = samplesFed * 1_000_000L / sampleRate;
                            audioEncoder.queueInputBuffer(inIndex, 0, frameBytes, ptsUs, 0);
                            lastAudioPtsUs = ptsUs;
                            inputOffset += chunk;
                            samplesFed += AAC_FRAME_SAMPLES;
                        }
                    }
                }
                int outIndex = audioEncoder.dequeueOutputBuffer(info, 10_000);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (!muxerStarted) {
                        muxAudioTrack = muxer.addTrack(audioEncoder.getOutputFormat());
                        muxer.start();
                        muxerStarted = true;
                    }
                } else if (outIndex >= 0) {
                    ByteBuffer encodedChunk = audioEncoder.getOutputBuffer(outIndex);
                    if (encodedChunk != null && info.size > 0 && muxerStarted) {
                        encodedChunk.position(info.offset);
                        encodedChunk.limit(info.offset + info.size);
                        muxer.writeSampleData(muxAudioTrack, encodedChunk, info);
                    }
                    audioEncoder.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        outputDone = true;
                    }
                }
            }
            if (!muxerStarted || muxAudioTrack < 0) throw new IOException("AAC 编码器未产出格式");
            if (!outputDone) throw new IOException("AAC 编码超时");

            // 5) 拷贝视频样本（时间戳原样保留）
            extractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC);
            int maxSample = 1 << 20;
            ByteBuffer sample = ByteBuffer.allocate(maxSample);
            while (true) {
                int size = extractor.readSampleData(sample, 0);
                if (size < 0) break;
                sample.position(0);
                sample.limit(size);
                info.offset = 0;
                info.size = size;
                info.flags = extractor.getSampleFlags() & MediaCodec.BUFFER_FLAG_SYNC_FRAME;
                info.presentationTimeUs = extractor.getSampleTime();
                muxer.writeSampleData(muxVideoTrack, sample, info);
                extractor.advance();
            }

            muxer.stop();
            if (!out.exists() || out.length() == 0) throw new IOException("混音输出为空");

            // PCM 按视频时长渲染而来，两者只应差毫秒级；差太多说明哪一端出问题
            if (videoDurationUs > 0 && Math.abs(audioDurationUs - videoDurationUs) > 200_000) {
                throw new IOException("音画时长差过大：" + audioDurationUs / 1000 + "ms vs "
                        + videoDurationUs / 1000 + "ms");
            }

            // 6) 自检：容器时长必须还是原来那条片子的长度。
            //    曾经因为音频 PTS 算错，视频 37 秒、容器却写了十几小时，
            //    播放器播完路线就一直定在海报帧上。这里宁可回退静音也不交付坏片子。
            long outMs = probeDurationMs(out);
            if (videoDurationUs > 0 && outMs > 0
                    && Math.abs(outMs - videoDurationUs / 1000) > DURATION_TOLERANCE_MS) {
                throw new IOException("混流后时长异常：" + outMs + "ms vs " + videoDurationUs / 1000 + "ms");
            }
            return new Result(SystemClock.elapsedRealtime() - started, audioDurationUs / 1000, outMs);
        } finally {
            try { if (audioEncoder != null) audioEncoder.stop(); } catch (Exception ignored) { }
            try { if (audioEncoder != null) audioEncoder.release(); } catch (Exception ignored) { }
            try { if (muxer != null) muxer.release(); } catch (Exception ignored) { }
            try { if (extractor != null) extractor.release(); } catch (Exception ignored) { }
        }
    }

    private static long probeDurationMs(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
            String value = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            return value == null ? 0 : Long.parseLong(value.trim());
        } catch (Exception ignored) {
            return 0;
        } finally {
            try { retriever.release(); } catch (Exception ignored) { }
        }
    }

    private static long computeDurationUs(int pcmBytes, int sampleRate, int channels) {
        long frames = pcmBytes / (2L * Math.max(1, channels));
        return frames * 1_000_000L / sampleRate;
    }
}
