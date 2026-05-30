import { createHash, randomBytes, randomUUID } from 'crypto';
import path from 'path';
import express, { ErrorRequestHandler, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { MongoClient, ObjectId, type Db, type Sort } from 'mongodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

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
  furnaceLevelFormatted?: string;
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

type AuthProvider = 'google' | 'discord';

type LinkedPlayerAccount = PlayerProfile & {
  linkedAt: Date;
};

type UserDocument = {
  _id?: ObjectId;
  email?: string;
  displayName: string;
  avatarUrl?: string;
  providers: {
    provider: AuthProvider;
    providerUserId: string;
    email?: string;
    linkedAt: Date;
  }[];
  playerAccounts: LinkedPlayerAccount[];
  createdAt: Date;
  updatedAt: Date;
};

type SessionDocument = {
  _id?: ObjectId;
  sessionHash: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
};

type OAuthStateDocument = {
  _id?: ObjectId;
  stateHash: string;
  provider: AuthProvider;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
};

type OAuthProfile = {
  provider: AuthProvider;
  providerUserId: string;
  email?: string;
  displayName: string;
  avatarUrl?: string;
};

type UploadedRequest = Request & {
  file?: Express.Multer.File;
};

const app = express();
const port = process.env.DAYBREAK_PORT || process.env.PORT || 3001;
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
const playerCache = new Map<string, { expiresAt: number; profile: PlayerProfile }>();
const playerCacheTtlMs = Number(process.env.DAYBREAK_PLAYER_CACHE_TTL_MS || 10 * 60 * 1000);

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

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const appUrl = normalizePublicUrl(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000');
const apiUrl = normalizePublicUrl(process.env.PUBLIC_API_URL || process.env.BACKEND_PUBLIC_URL || `http://localhost:${port}`);
const authCookieName = process.env.AUTH_COOKIE_NAME || 'wos_session';
const authCookieSecure = process.env.AUTH_COOKIE_SECURE === 'true' || apiUrl.startsWith('https://');
const authCookieSameSite = (process.env.AUTH_COOKIE_SAMESITE || (authCookieSecure ? 'None' : 'Lax')) as 'Lax' | 'Strict' | 'None';
const authCookieMaxAgeMs = Number(process.env.AUTH_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);

const oauthConfig = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile',
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userInfoUrl: 'https://discord.com/api/users/@me',
    scope: 'identify email',
  },
} satisfies Record<AuthProvider, {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}>;

const isProviderConfigured = (provider: AuthProvider) =>
  provider === 'discord'
    ? Boolean(oauthConfig.discord.clientId && (oauthConfig.discord.clientSecret || process.env.DISCORD_TOKEN_EXCHANGE_URL))
    : Boolean(oauthConfig[provider].clientId && oauthConfig[provider].clientSecret);

const getRedirectUri = (provider: AuthProvider) => `${apiUrl}/api/auth/${provider}/callback`;

const parseCookies = (header: string | undefined) =>
  Object.fromEntries(
    (header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) {
          return [part, ''];
        }

        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );

const setSessionCookie = (res: Response, sessionToken: string) => {
  const parts = [
    `${authCookieName}=${encodeURIComponent(sessionToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(authCookieMaxAgeMs / 1000)}`,
    `SameSite=${authCookieSameSite}`,
  ];

  if (authCookieSecure) {
    parts.push('Secure');
  }
  if (process.env.AUTH_COOKIE_DOMAIN) {
    parts.push(`Domain=${process.env.AUTH_COOKIE_DOMAIN}`);
  }

  res.setHeader('Set-Cookie', parts.join('; '));
};

const clearSessionCookie = (res: Response) => {
  const parts = [
    `${authCookieName}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=${authCookieSameSite}`,
  ];

  if (authCookieSecure) {
    parts.push('Secure');
  }
  if (process.env.AUTH_COOKIE_DOMAIN) {
    parts.push(`Domain=${process.env.AUTH_COOKIE_DOMAIN}`);
  }

  res.setHeader('Set-Cookie', parts.join('; '));
};

const safeReturnTo = (value: unknown) => {
  const raw = cleanText(value, 300);
  if (!raw) {
    return appUrl;
  }

  try {
    const url = new URL(raw, appUrl);
    const appOrigin = new URL(appUrl).origin;
    return url.origin === appOrigin ? url.toString() : appUrl;
  } catch {
    return appUrl;
  }
};

const formatFurnaceLevel = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return '0';
  }

  const level = Number(value);
  if (!Number.isFinite(level)) {
    return String(value);
  }

  const lv = Math.trunc(level);
  if (lv <= 30) return String(lv);
  if (lv === 31) return '30-1';
  if (lv === 32) return '30-2';
  if (lv === 33) return '30-3';
  if (lv === 34) return '30-4';
  if (lv === 35) return '1';
  if (lv === 36) return '1-1';
  if (lv === 37) return '1-2';
  if (lv === 38) return '1-3';
  if (lv === 39) return '1-4';
  if (lv === 40) return '2';
  if (lv === 41) return '2-1';
  if (lv === 42) return '2-1';
  if (lv === 43) return '2-1';
  if (lv === 44) return '2-2';
  if (lv === 45) return '3';

  const relative = lv - 45;
  const tier = Math.floor(relative / 5) + 3;
  const stage = relative % 5;
  return stage === 0 ? String(tier) : `${tier}-${stage}`;
};

const parsePositiveInt = (value: unknown, fallback: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(parsed), max);
};

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
  const cached = playerCache.get(playerId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.profile;
  }

  const apiUrls = [
    'https://wos-giftcode-api.centurygame.com/api/player',
    'https://gof-report-api-formal.centurygame.com/api/player',
  ];
  let payload: any = null;

  for (const apiUrl of apiUrls) {
    const currentTime = Date.now();
    const form = `fid=${playerId}&time=${currentTime}`;
    const sign = createHash('md5').update(`${form}tB87#kPtkxqOS2`).digest('hex');
    const body = `sign=${sign}&${form}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://wos-giftcode-api.centurygame.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body,
    });

    if (!response.ok) {
      continue;
    }

    const candidate = await response.json().catch(() => null);
    if (candidate?.data) {
      payload = candidate;
      break;
    }
  }

  if (!payload?.data) {
    return null;
  }

  const data = payload.data;
  const furnaceLevel = Number(data.stove_lv);
  const profile = {
    playerId,
    nickname: cleanText(data.nickname, 80) || `Player ${playerId}`,
    stateId: data.kid ? String(data.kid) : undefined,
    furnaceLevel: Number.isFinite(furnaceLevel) ? furnaceLevel : undefined,
    furnaceLevelFormatted: Number.isFinite(furnaceLevel) ? formatFurnaceLevel(furnaceLevel) : undefined,
    furnaceIcon: cleanText(data.stove_lv_content, 240) || undefined,
    avatarImage: cleanText(data.avatar_image, 240) || undefined,
  };

  playerCache.set(playerId, { expiresAt: Date.now() + playerCacheTtlMs, profile });
  return profile;
};

const getDb = async () => {
  if (mongoDb) {
    return mongoDb;
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGODB_URI or MONGO_URI is required');
  }

  mongoClient = new MongoClient(uri, {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 30),
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB || 'whiteoutsurvival_dev');
  return mongoDb;
};

const getCollections = async () => {
  const db = await getDb();
  const islands = db.collection<IslandDocument>('daybreak_islands');
  const likes = db.collection<IslandLikeDocument>('daybreak_island_likes');
  const comments = db.collection<IslandCommentDocument>('daybreak_island_comments');
  const users = db.collection<UserDocument>('users');
  const sessions = db.collection<SessionDocument>('auth_sessions');
  const oauthStates = db.collection<OAuthStateDocument>('auth_oauth_states');

  indexesReady ??= Promise.all([
    islands.createIndex({ createdAt: -1 }),
    islands.createIndex({ likes: -1, createdAt: -1 }),
    islands.createIndex({ playerId: 1 }),
    likes.createIndex({ islandId: 1, viewerId: 1 }, { unique: true }),
    comments.createIndex({ islandId: 1, createdAt: -1 }),
    users.createIndex({ 'providers.provider': 1, 'providers.providerUserId': 1 }),
    users.createIndex({ email: 1 }, { sparse: true }),
    users.createIndex({ 'playerAccounts.playerId': 1 }),
    sessions.createIndex({ sessionHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    oauthStates.createIndex({ stateHash: 1 }, { unique: true }),
    oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]).then(() => undefined);

  await indexesReady;
  return { islands, likes, comments, users, sessions, oauthStates };
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

const toUserResponse = (user: UserDocument) => ({
  id: user._id?.toString(),
  email: user.email,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  providers: user.providers.map((provider) => provider.provider),
  playerAccounts: user.playerAccounts.map((player) => ({
    playerId: player.playerId,
    nickname: player.nickname,
    stateId: player.stateId,
    furnaceLevel: player.furnaceLevel,
    furnaceLevelFormatted: player.furnaceLevelFormatted,
    furnaceIcon: player.furnaceIcon,
    avatarImage: player.avatarImage,
    linkedAt: player.linkedAt.toISOString(),
  })),
  createdAt: user.createdAt.toISOString(),
});

const getCurrentUser = async (req: Request) => {
  const sessionToken = parseCookies(req.get('cookie'))[authCookieName];
  if (!sessionToken) {
    return null;
  }

  const { users, sessions } = await getCollections();
  const session = await sessions.findOne({ sessionHash: sha256(sessionToken), expiresAt: { $gt: new Date() } });
  if (!session) {
    return null;
  }

  return users.findOne({ _id: session.userId });
};

const requireCurrentUser = async (req: Request, res: Response) => {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }

  return user;
};

const createSession = async (res: Response, userId: ObjectId) => {
  const sessionToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + authCookieMaxAgeMs);
  const { sessions } = await getCollections();
  await sessions.insertOne({
    sessionHash: sha256(sessionToken),
    userId,
    createdAt: now,
    expiresAt,
  });
  setSessionCookie(res, sessionToken);
};

const upsertOAuthUser = async (profile: OAuthProfile) => {
  const now = new Date();
  const { users } = await getCollections();
  const providerMatch = {
    'providers.provider': profile.provider,
    'providers.providerUserId': profile.providerUserId,
  };
  let user = await users.findOne(providerMatch);

  if (!user && profile.email) {
    user = await users.findOne({ email: profile.email.toLowerCase() });
  }

  if (!user) {
    const document: UserDocument = {
      email: profile.email?.toLowerCase(),
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      providers: [{
        provider: profile.provider,
        providerUserId: profile.providerUserId,
        email: profile.email?.toLowerCase(),
        linkedAt: now,
      }],
      playerAccounts: [],
      createdAt: now,
      updatedAt: now,
    };
    const result = await users.insertOne(document);
    return { ...document, _id: result.insertedId };
  }

  const hasProvider = user.providers.some(
    (provider) => provider.provider === profile.provider && provider.providerUserId === profile.providerUserId,
  );
  const update = hasProvider
    ? {
        $set: {
          email: user.email || profile.email?.toLowerCase(),
          displayName: profile.displayName || user.displayName,
          avatarUrl: profile.avatarUrl || user.avatarUrl,
          updatedAt: now,
        },
      }
    : {
        $set: {
          email: user.email || profile.email?.toLowerCase(),
          displayName: profile.displayName || user.displayName,
          avatarUrl: profile.avatarUrl || user.avatarUrl,
          updatedAt: now,
        },
        $push: {
          providers: {
            provider: profile.provider,
            providerUserId: profile.providerUserId,
            email: profile.email?.toLowerCase(),
            linkedAt: now,
          },
        },
      };

  await users.updateOne({ _id: user._id }, update);
  return (await users.findOne({ _id: user._id })) || user;
};

const exchangeOAuthCode = async (provider: AuthProvider, code: string) => {
  const config = oauthConfig[provider];

  if (provider === 'discord' && !config.clientSecret && process.env.DISCORD_TOKEN_EXCHANGE_URL) {
    const proxyResponse = await fetch(process.env.DISCORD_TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, redirect_uri: getRedirectUri(provider) }),
    });
    const proxyData = await proxyResponse.json().catch(() => null);
    const providerUser = proxyData?.user;
    if (!proxyResponse.ok || !providerUser?.id) {
      throw new Error('Discord OAuth exchange failed');
    }

    const avatarUrl = providerUser.avatar
      ? `https://cdn.discordapp.com/avatars/${providerUser.id}/${providerUser.avatar}.png?size=128`
      : undefined;
    return {
      provider,
      providerUserId: String(providerUser.id),
      email: cleanText(providerUser.email, 240).toLowerCase() || undefined,
      displayName: cleanText(providerUser.global_name || providerUser.username, 120) || 'Discord User',
      avatarUrl,
    } satisfies OAuthProfile;
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(provider),
  });

  const tokenResponse = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenData?.access_token) {
    throw new Error('OAuth token exchange failed');
  }

  const profileResponse = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
  });
  const providerUser = await profileResponse.json().catch(() => null);
  if (!profileResponse.ok || !providerUser?.id) {
    throw new Error('OAuth profile lookup failed');
  }

  if (provider === 'google') {
    return {
      provider,
      providerUserId: String(providerUser.id),
      email: cleanText(providerUser.email, 240).toLowerCase() || undefined,
      displayName: cleanText(providerUser.name, 120) || 'Google User',
      avatarUrl: cleanText(providerUser.picture, 600) || undefined,
    } satisfies OAuthProfile;
  }

  const avatarUrl = providerUser.avatar
    ? `https://cdn.discordapp.com/avatars/${providerUser.id}/${providerUser.avatar}.png?size=128`
    : undefined;
  return {
    provider,
    providerUserId: String(providerUser.id),
    email: cleanText(providerUser.email, 240).toLowerCase() || undefined,
    displayName: cleanText(providerUser.global_name || providerUser.username, 120) || 'Discord User',
    avatarUrl,
  } satisfies OAuthProfile;
};

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

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length
    ? (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Origin is not allowed by CORS'));
      }
    : true,
  credentials: true,
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Whiteout Survival backend is running' });
});

app.get('/api/auth/providers', (_req, res) => {
  res.json({
    providers: {
      google: isProviderConfigured('google'),
      discord: isProviderConfigured('discord'),
    },
  });
});

app.get('/api/auth/session', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    res.json({ user: user ? toUserResponse(user) : null });
  } catch (error) {
    sendStorageError(res, error);
  }
});

app.get('/api/auth/:provider', async (req, res) => {
  const provider = req.params.provider as AuthProvider;
  if (!['google', 'discord'].includes(provider)) {
    res.status(404).json({ error: 'Auth provider not found' });
    return;
  }

  if (!isProviderConfigured(provider)) {
    res.redirect(`${appUrl}?auth_error=${encodeURIComponent(`${provider} sign-in is not configured`)}`);
    return;
  }

  try {
    const state = randomBytes(24).toString('base64url');
    const now = new Date();
    const { oauthStates } = await getCollections();
    await oauthStates.insertOne({
      stateHash: sha256(state),
      provider,
      returnTo: safeReturnTo(req.query.returnTo),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    });

    const config = oauthConfig[provider];
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: getRedirectUri(provider),
      response_type: 'code',
      scope: config.scope,
      state,
      prompt: provider === 'google' ? 'select_account' : 'none',
    });

    res.redirect(`${config.authorizeUrl}?${params.toString()}`);
  } catch (error) {
    sendStorageError(res, error);
  }
});

app.get('/api/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider as AuthProvider;
  if (!['google', 'discord'].includes(provider)) {
    res.redirect(`${appUrl}?auth_error=${encodeURIComponent('Auth provider not found')}`);
    return;
  }

  try {
    const code = cleanText(req.query.code, 1200);
    const state = cleanText(req.query.state, 240);
    if (!code || !state) {
      throw new Error('Missing OAuth callback data');
    }

    const { oauthStates } = await getCollections();
    const stateDocument = await oauthStates.findOneAndDelete({
      stateHash: sha256(state),
      provider,
      expiresAt: { $gt: new Date() },
    });
    if (!stateDocument) {
      throw new Error('OAuth state expired or invalid');
    }

    const profile = await exchangeOAuthCode(provider, code);
    const user = await upsertOAuthUser(profile);
    if (!user._id) {
      throw new Error('Unable to create user session');
    }

    await createSession(res, user._id);
    res.redirect(stateDocument.returnTo || appUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sign-in failed';
    res.redirect(`${appUrl}?auth_error=${encodeURIComponent(message)}`);
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const sessionToken = parseCookies(req.get('cookie'))[authCookieName];
    if (sessionToken) {
      const { sessions } = await getCollections();
      await sessions.deleteOne({ sessionHash: sha256(sessionToken) });
    }

    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    sendStorageError(res, error);
  }
});

app.post('/api/profile/player-accounts', async (req, res) => {
  try {
    const user = await requireCurrentUser(req, res);
    if (!user?._id) {
      return;
    }

    const playerId = cleanPlayerId(req.body.playerId);
    if (!/^\d{8,9}$/.test(playerId)) {
      res.status(400).json({ error: 'Player ID must be 8 or 9 digits' });
      return;
    }

    const player = await fetchPlayerProfile(playerId);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    const { users } = await getCollections();
    const now = new Date();
    const linkedPlayer: LinkedPlayerAccount = { ...player, linkedAt: now };
    await users.updateOne(
      { _id: user._id, 'playerAccounts.playerId': { $ne: playerId } },
      { $push: { playerAccounts: linkedPlayer }, $set: { updatedAt: now } },
    );

    const updatedUser = await users.findOne({ _id: user._id });
    res.json({ user: updatedUser ? toUserResponse(updatedUser) : toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unable to link player account' });
  }
});

app.get('/api/daybreak/islands', async (req, res) => {
  try {
    const sort: Sort =
      req.query.sort === 'popular'
        ? { likes: -1 as const, createdAt: -1 as const }
        : { createdAt: -1 as const };
    const limit = parsePositiveInt(req.query.limit, 24, 60);
    const skip = Math.min(Math.max(Number(req.query.skip) || 0, 0), 5000);
    const { islands } = await getCollections();
    const [results, total] = await Promise.all([
      islands.find().sort(sort).skip(skip).limit(limit).toArray(),
      islands.estimatedDocumentCount(),
    ]);
    res.json({ islands: results.map(toIslandResponse), page: { limit, skip, total } });
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

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Request failed';
  const isUploadLimit = message.includes('File too large');
  const isUploadType = message.includes('Only image uploads are supported');
  const isCors = message.includes('Origin is not allowed by CORS');

  res.status(isCors ? 403 : isUploadLimit || isUploadType ? 400 : 500).json({
    error: isCors ? 'Origin is not allowed' : isUploadLimit || isUploadType ? 'Invalid upload' : 'Request failed',
    detail: message,
  });
};

app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
