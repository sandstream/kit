/**
 * CDN Cache Header Examples
 *
 * Demonstrates proper Cache-Control headers for different endpoint types
 * to optimize CloudFront caching behavior.
 */

import { NextRequest, NextResponse } from 'next/server';

// ─── Public API Endpoints (Cacheable) ───────────────────────────────────

export async function getPublicPlugins(req: NextRequest) {
  const data = await fetchPublicPlugins();

  return NextResponse.json(data, {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
      'Content-Type': 'application/json',
      'ETag': generateETag(data),
    },
  });
}

export async function getPluginDetails(req: NextRequest, { slug }: { slug: string }) {
  const plugin = await fetchPluginBySlug(slug);

  return NextResponse.json(plugin, {
    headers: {
      // Cache for 1 hour, allow stale content for up to 1 day
      'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      'Content-Type': 'application/json',
      'ETag': generateETag(plugin),
      'Last-Modified': new Date(plugin.updatedAt).toUTCString(),
    },
  });
}

export async function searchPlugins(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('q');
  const results = await searchPluginsByQuery(query!);

  return NextResponse.json(results, {
    headers: {
      // Search results cached, but include query string in cache key
      'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
      'Content-Type': 'application/json',
      'Vary': 'Accept-Encoding, Accept-Language',
    },
  });
}

// ─── User-Specific API Endpoints (Short TTL) ───────────────────────────

export async function getUserProfile(req: NextRequest) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  return NextResponse.json(user, {
    headers: {
      // Cache user data briefly (1 minute)
      'Cache-Control': 'private, max-age=60, s-maxage=300',
      'Content-Type': 'application/json',
      'Vary': 'Authorization, Cookie',
    },
  });
}

export async function getUserPlugins(req: NextRequest) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const plugins = await fetchUserPlugins(user.id);

  return NextResponse.json(plugins, {
    headers: {
      // User's plugins cached briefly with authorization context
      'Cache-Control': 'private, max-age=60, s-maxage=300',
      'Content-Type': 'application/json',
      'Vary': 'Authorization, Cookie, X-User-ID',
    },
  });
}

export async function getUserSettings(req: NextRequest) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const settings = await fetchUserSettings(user.id);

  return NextResponse.json(settings, {
    headers: {
      // Settings cached very briefly
      'Cache-Control': 'private, max-age=30, s-maxage=60',
      'Content-Type': 'application/json',
      'Vary': 'Authorization, Cookie',
    },
  });
}

// ─── Authenticated Endpoints (No Cache) ─────────────────────────────────

export async function createPlugin(req: NextRequest) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const body = await req.json();
  const plugin = await createNewPlugin(user.id, body);

  return NextResponse.json(plugin, {
    status: 201,
    headers: {
      // Never cache write operations
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': 'application/json',
    },
  });
}

export async function updatePluginSettings(
  req: NextRequest,
  { id }: { id: string }
) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const body = await req.json();
  const plugin = await updatePlugin(id, body);

  return NextResponse.json(plugin, {
    headers: {
      // Never cache write operations
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': 'application/json',
    },
  });
}

export async function deletePlugin(req: NextRequest, { id }: { id: string }) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  await deletePluginById(id);

  return new NextResponse(null, {
    status: 204,
    headers: {
      // Never cache delete operations
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

// ─── Authentication Endpoints (No Cache) ──────────────────────────────

export async function login(req: NextRequest) {
  const body = await req.json();
  const { token, user } = await authenticateUser(body.email, body.password);

  return NextResponse.json({ token, user }, {
    status: 200,
    headers: {
      // Never cache auth responses
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Set-Cookie': `authToken=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      'Content-Type': 'application/json',
    },
  });
}

export async function logout(req: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      // Never cache logout
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Set-Cookie': 'authToken=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    },
  });
}

export async function refreshToken(req: NextRequest) {
  const user = await getCurrentUser(req);

  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const newToken = await generateNewToken(user.id);

  return NextResponse.json({ token: newToken }, {
    headers: {
      // Never cache token refresh
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': 'application/json',
    },
  });
}

// ─── Utility Functions ────────────────────────────────────────────────

function generateETag(data: any): string {
  const hash = require('crypto')
    .createHash('md5')
    .update(JSON.stringify(data))
    .digest('hex');
  return `"${hash}"`;
}

async function getCurrentUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.split(' ')[1];

  if (!token) {
    return null;
  }

  return await verifyToken(token);
}

// Stub implementations
async function fetchPublicPlugins() {
  return [];
}

async function fetchPluginBySlug(slug: string) {
  return {};
}

async function searchPluginsByQuery(query: string) {
  return [];
}

async function fetchUserPlugins(userId: string) {
  return [];
}

async function fetchUserSettings(userId: string) {
  return {};
}

async function createNewPlugin(userId: string, data: any) {
  return {};
}

async function updatePlugin(id: string, data: any) {
  return {};
}

async function deletePluginById(id: string) {
  // ...
}

async function authenticateUser(email: string, password: string) {
  return { token: '', user: {} };
}

async function generateNewToken(userId: string) {
  return '';
}

async function verifyToken(token: string) {
  return null;
}
