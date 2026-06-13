import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDb } from './database.js';
import db from './database.js';
import { getMetadata, createAudioStream } from './audioService.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, '../public/uploads');
const GRAPHICS_DIR = path.resolve(__dirname, '../public/graphics');
const PODCASTS_DIR = path.resolve(__dirname, '../public/podcasts');

// S'assurer que les dossiers existent
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(GRAPHICS_DIR)) fs.mkdirSync(GRAPHICS_DIR, { recursive: true });
if (!fs.existsSync(PODCASTS_DIR)) fs.mkdirSync(PODCASTS_DIR, { recursive: true });

const app = express();
const port = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Middleware d'authentification simple
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (authHeader === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: 'Accès non autorisé' });
    }
};

// Configuration de Multer pour l'upload directement dans le dossier public
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        console.log(`[UPLOAD] Vérification du fichier : ${file.originalname}`);
        const allowedExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.mod', '.xm', '.s3m', '.it'];
        const ext = path.extname(file.originalname).toLowerCase();
        
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error('Format non supporté.'));
        }

        const fullPath = path.join(UPLOADS_DIR, file.originalname);
        if (fs.existsSync(fullPath)) {
            return cb(new Error('Ce fichier existe déjà sur le serveur.'));
        }

        cb(null, true);
    }
});

// Configuration Multer pour les images
const graphicsStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, GRAPHICS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const uploadGraphic = multer({
    storage: graphicsStorage,
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error('Format d\'image non supporté.'));
        }
        const fullPath = path.join(GRAPHICS_DIR, file.originalname);
        if (fs.existsSync(fullPath)) {
            return cb(new Error('Cette image existe déjà sur le serveur.'));
        }
        cb(null, true);
    }
});

// Configuration Multer pour les podcasts
const podcastsStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, PODCASTS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const uploadPodcast = multer({
    storage: podcastsStorage,
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.mp3', '.wav', '.m4a', '.ogg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error('Format audio podcast non supporté.'));
        }
        const fullPath = path.join(PODCASTS_DIR, file.originalname);
        if (fs.existsSync(fullPath)) {
            return cb(new Error('Ce podcast existe déjà sur le serveur.'));
        }
        cb(null, true);
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialisation de la base de données
initDb();

// Endpoint : Upload
app.post('/api/upload', (req, res) => {
    console.log('[API] Requête upload reçue');
    upload.single('music')(req, res, async (err) => {
        if (err) {
            console.error(`[UPLOAD ERROR] ${err.message}`);
            return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
            console.error('[UPLOAD ERROR] Aucun fichier reçu');
            return res.status(400).json({ error: 'Aucun fichier.' });
        }

        const { author } = req.body;
        const { filename, originalname, path: filePath } = req.file;
        const format = path.extname(originalname).substring(1);

        console.log(`[UPLOAD SUCCESS] Fichier enregistré : ${filename}`);

        // Vérification si le fichier est déjà enregistré en base de données
        db.get(`SELECT id FROM tracks WHERE filename = ?`, [filename], async (err, row) => {
            if (row) {
                console.log('[DB] Fichier déjà présent en base, skip insertion');
                return res.status(400).json({ error: 'Ce fichier est déjà enregistré dans la base de données.' });
            }

            try {
                const metadata = await getMetadata(filePath);
                const query = `INSERT INTO tracks (filename, original_name, author, format, duration) VALUES (?, ?, ?, ?, ?)`;
                db.run(query, [filename, metadata.title || originalname, author || metadata.artist || 'Anonyme', format, metadata.duration], function(err) {
                    if (err) console.error(`[DB ERROR] ${err.message}`);
                    res.json({ message: 'Musique uploadée !', trackId: this.lastID });
                });
            } catch (e) {
                console.warn(`[METADATA] Impossible de lire les métadonnées : ${e.message}`);
                const query = `INSERT INTO tracks (filename, original_name, author, format) VALUES (?, ?, ?, ?)`;
                db.run(query, [filename, originalname, author || 'Anonyme', format], function(err) {
                    if (err) console.error(`[DB ERROR] ${err.message}`);
                    res.json({ message: 'Musique uploadée (sans metadata).', trackId: this.lastID });
                });
            }
        });
    });
});

// Endpoint : Stream pour les formats Trackers (MOD, XM...)
// Les MP3/WAV sont servis directement par express.static('public')
app.get('/api/stream/:filename', (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    const ext = path.extname(req.params.filename).toLowerCase();
    
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

    // Si format standard, redirection vers le fichier statique
    if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
        return res.redirect(`/uploads/${req.params.filename}`);
    }

    // Sinon, conversion temps réel via FFmpeg
    res.set({ 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
    const stream = createAudioStream(filePath);
    stream.pipe(res, { end: true });
    req.on('close', () => { if (stream.kill) stream.kill(); });
});

app.get('/api/tracks', (req, res) => {
    // Le public ne voit que les musiques approuvées
    db.all(`SELECT * FROM tracks WHERE status = 'approved' ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// --- ROUTES ADMIN MUSIQUES ---

// Liste toutes les musiques (pour modération)
app.get('/api/admin/tracks', authMiddleware, (req, res) => {
    db.all(`SELECT * FROM tracks ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Approuver une musique
app.put('/api/admin/tracks/:id/approve', authMiddleware, (req, res) => {
    db.run(`UPDATE tracks SET status = 'approved' WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Musique approuvée.' });
    });
});

// Endpoint : Vérification Auth
app.get('/api/admin/verify', authMiddleware, (req, res) => {
    res.json({ success: true });
});

// Endpoint : Suppression (Admin)
app.delete('/api/tracks/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    
    // Récupérer le nom du fichier avant suppression
    db.get(`SELECT filename FROM tracks WHERE id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Piste non trouvée.' });

        const filePath = path.join(UPLOADS_DIR, row.filename);
        
        // Supprimer de la base de données
        db.run(`DELETE FROM tracks WHERE id = ?`, [id], (err) => {
            if (err) return res.status(500).json({ error: 'Erreur base de données.' });

            // Supprimer le fichier physique
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            console.log(`[ADMIN] Piste ${id} supprimée (${row.filename})`);
            res.json({ message: 'Piste supprimée avec succès.' });
        });
    });
});

// Endpoint : Synchronisation (Admin) - Scanne le dossier uploads
app.post('/api/admin/sync', authMiddleware, async (req, res) => {
    try {
        const files = fs.readdirSync(UPLOADS_DIR);
        const tracks = await new Promise<any[]>((resolve) => {
            db.all(`SELECT filename FROM tracks`, (err, rows) => resolve(rows || []));
        });

        const dbFilenames = tracks.map(t => t.filename);
        let added = 0;
        let removed = 0;

        // Ajouter les fichiers manquants en base
        for (const file of files) {
            if (!dbFilenames.includes(file)) {
                const filePath = path.join(UPLOADS_DIR, file);
                const format = path.extname(file).substring(1);
                try {
                    const metadata = await getMetadata(filePath);
                    db.run(`INSERT INTO tracks (filename, original_name, author, format, duration) VALUES (?, ?, ?, ?, ?)`,
                        [file, metadata.title || file, metadata.artist || 'Anonyme', format, metadata.duration]);
                    added++;
                } catch (e) {
                    db.run(`INSERT INTO tracks (filename, original_name, author, format) VALUES (?, ?, ?, ?)`,
                        [file, file, 'Anonyme', format]);
                    added++;
                }
            }
        }

        // Optionnel : Nettoyer la base des fichiers qui n'existent plus sur le disque
        for (const dbFile of dbFilenames) {
            if (!files.includes(dbFile)) {
                db.run(`DELETE FROM tracks WHERE filename = ?`, [dbFile]);
                removed++;
            }
        }

        console.log(`[SYNC] Terminé : +${added} / -${removed}`);
        res.json({ message: 'Synchronisation terminée', added, removed });
    } catch (err) {
        res.status(500).json({ error: 'Erreur lors de la synchronisation.' });
    }
});

// Endpoint : Mise à jour (Admin)
app.put('/api/tracks/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const { original_name, author } = req.body;

    if (!original_name) return res.status(400).json({ error: 'Le nom est obligatoire.' });

    db.run(`UPDATE tracks SET original_name = ?, author = ? WHERE id = ?`, 
        [original_name, author || 'Anonyme', id], 
        function(err) {
            if (err) return res.status(500).json({ error: 'Erreur base de données.' });
            if (this.changes === 0) return res.status(404).json({ error: 'Piste non trouvée.' });
            
            console.log(`[ADMIN] Piste ${id} mise à jour : ${original_name} by ${author}`);
            res.json({ message: 'Piste mise à jour.' });
        }
    );
});

// Endpoint : Récupérer les messages (Public)
app.get('/api/messages', (req, res) => {
    db.all(`SELECT * FROM messages WHERE active = 1 ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Table des messages personnalisés (Ajout colonne couleur si besoin via DB init, mais on gère ici)
// On ajoute un endpoint pour désapprouver une musique
app.put('/api/admin/tracks/:id/disapprove', authMiddleware, (req, res) => {
    db.run(`UPDATE tracks SET status = 'pending' WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Musique remise en attente.' });
    });
});

// On ajoute un endpoint pour désapprouver une image
app.put('/api/admin/graphics/:id/disapprove', authMiddleware, (req, res) => {
    db.run(`UPDATE graphics SET status = 'pending' WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Image remise en attente.' });
    });
});

// Endpoint : Synchronisation Images (Admin)
app.post('/api/admin/graphics/sync', authMiddleware, async (req, res) => {
    try {
        const files = fs.readdirSync(GRAPHICS_DIR).filter(f => ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(f).toLowerCase()));
        const dbFiles = await new Promise<any[]>((resolve) => {
            db.all(`SELECT filename FROM graphics`, (err, rows) => resolve(rows || []));
        });
        const dbFilenames = dbFiles.map(g => g.filename);
        let added = 0;
        for (const file of files) {
            if (!dbFilenames.includes(file)) {
                // Changement : Statut 'pending' par défaut au lieu de 'approved'
                db.run(`INSERT INTO graphics (filename, author, status) VALUES (?, 'System Sync', 'pending')`, [file]);
                added++;
            }
        }
        res.json({ message: 'Sync images terminée', added });
    } catch (err) {
        res.status(500).json({ error: 'Erreur sync images.' });
    }
});

// Mise à jour de la couleur d'un message
app.put('/api/messages/:id/color', authMiddleware, (req, res) => {
    const { color } = req.body;
    db.run(`UPDATE messages SET color = ? WHERE id = ?`, [color, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Couleur mise à jour.' });
    });
});

app.post('/api/messages', authMiddleware, (req, res) => {
    const { text, color } = req.body;
    if (!text) return res.status(400).json({ error: 'Le texte est vide.' });
    db.run(`INSERT INTO messages (text, color) VALUES (?, ?)`, [text, color || '#ff00ff'], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Message ajouté.', id: this.lastID });
    });
});

// Endpoint : Supprimer un message (Admin)
app.delete('/api/messages/:id', authMiddleware, (req, res) => {
    db.run(`DELETE FROM messages WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Message supprimé.' });
    });
});

// Endpoint : Image Aléatoire (Graphisme) - Uniquement les images approuvées
app.get('/api/graphics/random', (req, res) => {
    db.all(`SELECT filename FROM graphics WHERE status = 'approved'`, (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(404).json({ error: 'Aucune image approuvée trouvée.' });
        }
        const randomFile = rows[Math.floor(Math.random() * rows.length)].filename;
        res.json({ url: `/graphics/${randomFile}`, name: randomFile });
    });
});

// Endpoint : Upload d'Image (Graphisme) - Statut 'pending' par défaut
app.post('/api/graphics/upload', (req, res) => {
    uploadGraphic.single('graphic')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
        
        const { author } = req.body;
        const filename = req.file.filename;
        db.run(`INSERT INTO graphics (filename, author, status) VALUES (?, ?, 'pending')`, [filename, author || 'Anonyme'], function(err) {
            if (err) return res.status(500).json({ error: 'Erreur base de données.' });
            console.log(`[GRAPHIC] Image en attente de modération : ${filename} by ${author}`);
            res.json({ message: 'Image envoyée ! Elle sera visible après validation par un admin.' });
        });
    });
});

// --- ROUTES ADMIN GRAPHISMES ---

// Liste toutes les images pour modération
app.get('/api/admin/graphics', authMiddleware, (req, res) => {
    db.all(`SELECT * FROM graphics ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Valider une image
app.put('/api/admin/graphics/:id/approve', authMiddleware, (req, res) => {
    db.run(`UPDATE graphics SET status = 'approved' WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Image approuvée.' });
    });
});

// Supprimer/Rejeter une image
app.delete('/api/admin/graphics/:id', authMiddleware, (req, res) => {
    db.get(`SELECT filename FROM graphics WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Image non trouvée.' });

        const filePath = path.join(GRAPHICS_DIR, row.filename);
        db.run(`DELETE FROM graphics WHERE id = ?`, [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: 'Erreur base de données.' });
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            res.json({ message: 'Image supprimée.' });
        });
    });
});

// --- ROUTES PODCASTS ---

// Endpoint : Upload de Podcast
app.post('/api/podcasts/upload', (req, res) => {
    uploadPodcast.single('podcast')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier podcast.' });

        const { title, author, description } = req.body;
        const filename = req.file.filename;

        try {
            const metadata = await getMetadata(req.file.path);
            db.run(`INSERT INTO podcasts (title, author, description, filename, duration, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
                [title || metadata.title || filename, author || metadata.artist || 'Anonyme', description || '', filename, metadata.duration],
                function(err) {
                    if (err) return res.status(500).json({ error: 'Erreur base de données.' });
                    res.json({ message: 'Podcast envoyé ! En attente de validation.', id: this.lastID });
                }
            );
        } catch (e) {
            db.run(`INSERT INTO podcasts (title, author, description, filename, status) VALUES (?, ?, ?, ?, 'pending')`,
                [title || filename, author || 'Anonyme', description || '', filename],
                function(err) {
                    if (err) return res.status(500).json({ error: 'Erreur base de données.' });
                    res.json({ message: 'Podcast envoyé (sans metadata) ! En attente de validation.', id: this.lastID });
                }
            );
        }
    });
});

// Endpoint : Liste des Podcasts (Public)
app.get('/api/podcasts', (req, res) => {
    db.all(`SELECT * FROM podcasts WHERE status = 'approved' ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Endpoint : Liste des Podcasts (Admin)
app.get('/api/admin/podcasts', authMiddleware, (req, res) => {
    db.all(`SELECT * FROM podcasts ORDER BY created_at DESC`, (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// Endpoint : Approuver Podcast
app.put('/api/admin/podcasts/:id/approve', authMiddleware, (req, res) => {
    db.run(`UPDATE podcasts SET status = 'approved' WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Podcast approuvé.' });
    });
});

// Endpoint : Désapprouver Podcast
app.put('/api/admin/podcasts/:id/disapprove', authMiddleware, (req, res) => {
    db.run(`UPDATE podcasts SET status = 'pending' WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'Erreur base de données.' });
        res.json({ message: 'Podcast mis en attente.' });
    });
});

// Endpoint : Supprimer Podcast
app.delete('/api/admin/podcasts/:id', authMiddleware, (req, res) => {
    db.get(`SELECT filename FROM podcasts WHERE id = ?`, [req.params.id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Podcast non trouvé.' });
        const filePath = path.join(PODCASTS_DIR, row.filename);
        db.run(`DELETE FROM podcasts WHERE id = ?`, [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: 'Erreur base de données.' });
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            res.json({ message: 'Podcast supprimé.' });
        });
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`[SERVER] Radio Demoscene.fr v2.0 - Running on port ${port}`);
});
