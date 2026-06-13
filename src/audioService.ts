import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import path from 'path';

// Configuration des chemins vers les binaires statiques
if (ffmpegStatic) {
    console.log(`[FFMPEG] Path set to: ${ffmpegStatic}`);
    ffmpeg.setFfmpegPath(ffmpegStatic);
}
ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface TrackMetadata {
    format: string;
    duration: number;
    artist?: string;
    title?: string;
}

export const getMetadata = (filePath: string): Promise<TrackMetadata> => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            
            const format = metadata.format.format_name || 'unknown';
            const duration = metadata.format.duration || 0;
            const tags = metadata.format.tags as any;

            resolve({
                format,
                duration,
                artist: tags?.artist || tags?.ARTIST || tags?.Artist,
                title: tags?.title || tags?.TITLE || tags?.Title
            });
        });
    });
};

/**
 * Prépare un flux audio standard à partir d'un fichier source.
 */
export const createAudioStream = (filePath: string) => {
    // On crée la commande FFmpeg
    const command = ffmpeg(filePath)
        .audioCodec('libmp3lame')
        .audioBitrate(192)
        .toFormat('mp3')
        .on('start', (commandLine) => {
            console.log(`[FFMPEG] Commande lancée : ${commandLine}`);
        })
        .on('error', (err) => {
            console.error(`[FFMPEG] Erreur interne : ${err.message}`);
        });

    return command; // fluent-ffmpeg permet de piper directement l'objet command
};
