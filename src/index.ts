import { createHash, randomUUID } from 'crypto';
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { MongoClient, ObjectId, type Db, type Sort } from 'mongodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

dotenv.config();

type IslandDocument = {
  _id?: ObjectId;
  title: string;
  creatorName: string;
  description: string;
  playerId: string;
  coordinates: {
    x: number;
    y: number;
  };
  player: PlayerProfile;
  server?: string;
  alliance?: string;
  tags: string[];
  imageUrl: string;
  objectKey: string;
  likes: number;
  shares: number;
  commentsCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type PlayerProfile = {
  playerId: string;
  nickname: string;
  stateId?: string;
  furnaceLevel?: number;
  furnaceIcon?: string;
  avatarImage?: string;
};

type IslandLikeDocument = {
  islandId: ObjectId;
  viewerId: string;
  createdAt: Date;
};

type IslandCommentDocument = {
  _id?: ObjectId;
  islandId: ObjectId;
  authorName: string;
  message: string;
  createdAt: Date;
};

type UploadedRequest = Request & {
  file?: Express.Multer.File;
};

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.DAYBREAK_MAX_UPLOAD_BYTES || 8 * 1024 * 1024),
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith('image/')) {
      callback(new Error('Only image uploads are supported'));
      return;
    }

    callback(null, true);
  },
});

const maxUploadBytes = Number(process.env.DAYBREAK_MAX_UPLOAD_BYTES || 8 * 1024 * 1024);

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let indexesReady: Promise<void> | null = null;

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
};

const normalizePublicUrl = (value: string) => value.replace(/\/+$/, '');

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 72) || 'island';

const parseTags = (value: unknown) => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
};

const cleanText = (value: unknown, maxLength: number) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

const cleanPlayerId = (value: unknown) => cleanText(value, 16).replace(/\D/g, '');

const parseCoordinate = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const normalizeExternalImageUrl = (value: unknown) => {
  const raw = cleanText(value, 600);
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }

    const driveMatch = url.hostname.includes('drive.google.com')
      ? raw.match(/\/file\/d\/([^/]+)/) || raw.match(/[?&]id=([^&]+)/)
      : null;
    if (driveMatch?.[1]) {
      return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
    }

    return url.toString();
  } catch {
    return '';
  }
};

const fetchPlayerProfile = async (playerId: string): Promise<PlayerProfile | null> => {
  const currentTime = Date.now();
  const form = `fid=${playerId}&time=${currentTime}`;
  const sign = createHash('md5').update(`${form}tB87#kPtkxqOS2`).digest('hex');
  const body = `sign=${sign}&${form}`;

  const response = await fetch('https://wos-giftcode-api.centurygame.com/api/player', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://wos-giftcode.centurygame.com',
      Referer: 'https://wos-giftcode.centurygame.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body,
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== 0 || !payload.data) {
    return null;
  }

  const data = payload.data;
  const furnaceLevel = Number(data.stove_lv);
  return {
    playerId,
    nickname: cleanText(data.nickname, 80) || `Player ${playerId}`,
    stateId: data.kid ? String(data.kid) : undefined,
    furnaceLevel: Number.isFinite(furnaceLevel) ? furnaceLevel : undefined,
    furnaceIcon: cleanText(data.stove_lv_content, 240) || undefined,
    avatarImage: cleanText(data.avatar_image, 240) || undefined,
  };
};

const getDb = async () => {
  if (mongoDb) {
    return mongoDb;
  }

  const uri = required('MONGODB_URI');
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB || 'whiteoutsurvival_dev');
  return mongoDb;
};

const getCollections = async () => {
  const db = await getDb();
  const islands = db.collection<IslandDocument>('daybreak_islands');
  const likes = db.collection<IslandLikeDocument>('daybreak_island_likes');
  const comments = db.collection<IslandCommentDocument>('daybreak_island_comments');

  indexesReady ??= Promise.all([
    islands.createIndex({ createdAt: -1 }),
    islands.createIndex({ likes: -1, createdAt: -1 }),
    islands.createIndex({ playerId: 1 }),
    likes.createIndex({ islandId: 1, viewerId: 1 }, { unique: true }),
    comments.createIndex({ islandId: 1, createdAt: -1 }),
  ]).then(() => undefined);

  await indexesReady;
  return { islands, likes, comments };
};

const toIslandResponse = (island: IslandDocument) => ({
  id: island._id?.toString(),
  title: island.title,
  creatorName: island.creatorName,
  description: island.description,
  playerId: island.playerId,
  coordinates: island.coordinates,
  player: island.player,
  server: island.server,
  alliance: island.alliance,
  tags: island.tags,
  imageUrl: island.imageUrl,
  likes: island.likes,
  shares: island.shares,
  commentsCount: island.commentsCount || 0,
  createdAt: island.createdAt.toISOString(),
});

const toCommentResponse = (comment: IslandCommentDocument) => ({
  id: comment._id?.toString(),
  islandId: comment.islandId.toString(),
  authorName: comment.authorName,
  message: comment.message,
  createdAt: comment.createdAt.toISOString(),
});

const getR2Client = () => {
  const accountId = required('CLOUDFLARE_ACCOUNT_ID');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required('CLOUDFLARE_R2_ACCESS_KEY_ID'),
      secretAccessKey: required('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    },
  });
};

const uploadToR2 = async (file: Express.Multer.File, title: string) => {
  const bucket = required('CLOUDFLARE_R2_BUCKET');
  const publicUrl = normalizePublicUrl(required('CLOUDFLARE_R2_PUBLIC_URL'));
  const extension = file.originalname.includes('.')
    ? file.originalname.split('.').pop()?.toLowerCase()
    : file.mimetype.split('/').pop();
  const objectKey = `daybreak-islands/${Date.now()}-${slugify(title)}-${randomUUID()}.${extension || 'webp'}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return {
    imageUrl: `${publicUrl}/${objectKey}`,
    objectKey,
  };
};

const uploadRemoteImageToR2 = async (remoteUrl: string, title: string) => {
  const response = await fetch(remoteUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error('Image link could not be downloaded');
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error('Image link must point to an image file');
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxUploadBytes) {
    throw new Error('Image is larger than the upload limit');
  }

  const extension = contentType.split('/').pop()?.split(';')[0] || 'jpg';
  return uploadToR2(
    {
      buffer: bytes,
      mimetype: contentType,
      originalname: `remote.${extension}`,
    } as Express.Multer.File,
    title,
  );
};

const sendStorageError = (res: Response, error: unknown) => {
  const message = error instanceof Error ? error.message : 'Storage operation failed';
  const missingConfig = message.endsWith('is required');
  res.status(missingConfig ? 503 : 500).json({
    error: missingConfig ? 'Storage is not configured' : 'Storage operation failed',
    detail: message,
  });
};

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Whiteout Survival backend is running' });
});

app.get('/api/daybreak/islands', async (req, res) => {
  try {
    const sort: Sort =
      req.query.sort === 'popular'
        ? { likes: -1 as const, createdAt: -1 as const }
        : { createdAt: -1 as const };
    const limit = Math.min(Number(req.query.limit) || 24, 60);
    const { islands } = await getCollections();
    const results = await islands.find().sort(sort).limit(limit).toArray();
    res.json({ islands: results.map(toIslandResponse) });
  } catch (error) {
    sendStorageError(res, error);
  }
});

app.get('/api/daybreak/players/:playerId', async (req, res) => {
  try {
    const playerId = cleanPlayerId(req.params.playerId);
    if (!/^\d{8,9}$/.test(playerId)) {
      res.status(400).json({ error: 'Player ID must be 8 or 9 digits' });
      return;
    }

    const player = await fetchPlayerProfile(playerId);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    res.json({ player });
  } catch (error) {
    res.status(500).json({ error: 'Unable to fetch player details' });
  }
});

app.post('/api/daybreak/islands', upload.single('image'), async (req: UploadedRequest, res) => {
  try {
    const title = cleanText(req.body.title, 90);
    const description = cleanText(req.body.description, 420) || 'Shared Daybreak Island layout.';
    const playerId = cleanPlayerId(req.body.playerId);
    const coordinateX = parseCoordinate(req.body.coordinateX);
    const coordinateY = parseCoordinate(req.body.coordinateY);
    const imageUrlInput = normalizeExternalImageUrl(req.body.imageUrl);

    if (!title || !/^\d{8,9}$/.test(playerId) || coordinateX === null || coordinateY === null || (!req.file && !imageUrlInput)) {
      res.status(400).json({ error: 'Island title, player ID, X/Y coordinates, and an image file or image link are required' });
      return;
    }

    const player = await fetchPlayerProfile(playerId);
    if (!player) {
      res.status(404).json({ error: 'Player details could not be fetched from the WOS player API' });
      return;
    }

    const { imageUrl, objectKey } = req.file
      ? await uploadToR2(req.file, title)
      : await uploadRemoteImageToR2(imageUrlInput, title);
    const now = new Date();
    const document: IslandDocument = {
      title,
      creatorName: player.nickname,
      description,
      playerId,
      coordinates: {
        x: coordinateX,
        y: coordinateY,
      },
      player,
      server: player.stateId,
      alliance: undefined,
      tags: parseTags(req.body.tags),
      imageUrl,
      objectKey,
      likes: 0,
      shares: 0,
      commentsCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const { islands } = await getCollections();
    const result = await islands.insertOne(document);
    res.status(201).json({ island: toIslandResponse({ ...document, _id: result.insertedId }) });
  } catch (error) {
    sendStorageError(res, error);
  }
});

app.get('/api/daybreak/islands/:id/comments', async (req, res) => {
  try {
    const islandId = new ObjectId(req.params.id);
    const { comments } = await getCollections();
    const results = await comments.find({ islandId }).sort({ createdAt: -1 }).limit(30).toArray();
    res.json({ comments: results.map(toCommentResponse) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('hex string') ? 400 : 500).json({
      error: 'Unable to load comments',
    });
  }
});

app.post('/api/daybreak/islands/:id/comments', async (req, res) => {
  try {
    const islandId = new ObjectId(req.params.id);
    const authorName = cleanText(req.body.authorName, 60);
    const message = cleanText(req.body.message, 360);

    if (!authorName || !message) {
      res.status(400).json({ error: 'Name and comment are required' });
      return;
    }

    const { islands, comments } = await getCollections();
    const island = await islands.findOne({ _id: islandId });
    if (!island) {
      res.status(404).json({ error: 'Island not found' });
      return;
    }

    const now = new Date();
    await comments.insertOne({ islandId, authorName, message, createdAt: now });
    const updated = await islands.findOneAndUpdate(
      { _id: islandId },
      { $inc: { commentsCount: 1 }, $set: { updatedAt: now } },
      { returnDocument: 'after' },
    );
    const latest = await comments.find({ islandId }).sort({ createdAt: -1 }).limit(30).toArray();

    res.status(201).json({
      island: updated ? toIslandResponse(updated) : toIslandResponse(island),
      comments: latest.map(toCommentResponse),
    });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('hex string') ? 400 : 500).json({
      error: 'Unable to add comment',
    });
  }
});

app.post('/api/daybreak/islands/:id/like', async (req, res) => {
  try {
    const islandId = new ObjectId(req.params.id);
    const viewerId =
      cleanText(req.body.viewerId, 120) ||
      cleanText(req.get('x-viewer-id'), 120) ||
      req.ip ||
      'anonymous';
    const { islands, likes } = await getCollections();

    const likeResult = await likes.updateOne(
      { islandId, viewerId },
      { $setOnInsert: { islandId, viewerId, createdAt: new Date() } },
      { upsert: true },
    );

    if (likeResult.upsertedCount) {
      await islands.updateOne({ _id: islandId }, { $inc: { likes: 1 }, $set: { updatedAt: new Date() } });
    }

    const island = await islands.findOne({ _id: islandId });
    if (!island) {
      res.status(404).json({ error: 'Island not found' });
      return;
    }

    res.json({ island: toIslandResponse(island), liked: true });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('hex string') ? 400 : 500).json({
      error: 'Unable to like island',
    });
  }
});

app.post('/api/daybreak/islands/:id/share', async (req, res) => {
  try {
    const islandId = new ObjectId(req.params.id);
    const { islands } = await getCollections();
    const result = await islands.findOneAndUpdate(
      { _id: islandId },
      { $inc: { shares: 1 }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) {
      res.status(404).json({ error: 'Island not found' });
      return;
    }

    res.json({ island: toIslandResponse(result) });
  } catch (error) {
    res.status(error instanceof Error && error.message.includes('hex string') ? 400 : 500).json({
      error: 'Unable to share island',
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
