import {
  S2,
  AppendInput,
  AppendRecord,
  RangeNotSatisfiableError,
} from "@s2-dev/streamstore";
import {
  STREAM_NAME_PREFIX,
  DOC_ID_PATTERN,
  DOC_ID_MAX_LENGTH,
  MAX_RECORD_BYTES,
  MAX_OPS_PER_SEC,
  snapshotKey,
} from "@txtbox/shared";

interface Env {
  S2_ACCESS_TOKEN: string;
  S2_BASIN: string;
  R2_PUBLIC_BASE: string;
  SNAPSHOTS_BUCKET: R2Bucket;
  SESSION_LIMITER: RateLimit;
  APPEND_LIMITER: RateLimit;
  READ_LIMITER: RateLimit;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const READ_WAIT_SECONDS = 30;
const READ_LIMIT_COUNT = 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/session" && request.method === "POST") {
      return handleSession(request, env);
    }

    if (url.pathname === "/append" && request.method === "POST") {
      return handleAppend(request, env);
    }

    if (url.pathname === "/read" && request.method === "GET") {
      return handleRead(request, env);
    }

    return json({ error: "not found" }, 404);
  },
};

async function handleSession(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const docId = parseDocId(url);
  if (docId instanceof Response) return docId;

  const limited = await rateLimit(request, env.SESSION_LIMITER, "session", docId);
  if (limited) return limited;

  const snapshot = await findLatestSnapshot(docId, env);

  return json({
    docId,
    snapshotUrl: snapshot.url,
    snapshotSeqNum: snapshot.seqNum,
    limits: {
      maxRecordBytes: MAX_RECORD_BYTES,
      maxOpsPerSec: MAX_OPS_PER_SEC,
    },
  });
}

async function handleAppend(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const docId = parseDocId(url);
  if (docId instanceof Response) return docId;

  const limited = await rateLimit(request, env.APPEND_LIMITER, "append", docId);
  if (limited) return limited;

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength === 0) {
    return json({ error: "empty record" }, 400);
  }

  if (body.byteLength > MAX_RECORD_BYTES) {
    return json({ error: "record too large" }, 413);
  }

  const stream = streamForDoc(env, docId);
  try {
    const ack = await stream.append(
      AppendInput.create([AppendRecord.bytes({ body })]),
      { signal: request.signal },
    );

    return json({
      startSeqNum: ack.start.seqNum,
      endSeqNum: ack.end.seqNum,
      nextSeqNum: ack.end.seqNum,
    });
  } finally {
    await stream.close().catch(() => {});
  }
}

async function handleRead(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const docId = parseDocId(url);
  if (docId instanceof Response) return docId;

  const seqParam = url.searchParams.get("seq") ?? "0";
  const seqNum = Number(seqParam);
  if (!Number.isSafeInteger(seqNum) || seqNum < 0) {
    return json({ error: "invalid seq" }, 400);
  }

  const limited = await rateLimit(request, env.READ_LIMITER, "read", docId);
  if (limited) return limited;

  const stream = streamForDoc(env, docId);
  try {
    const batch = await stream.read(
      {
        start: { from: { seqNum }, clamp: true },
        stop: {
          limits: { count: READ_LIMIT_COUNT },
          waitSecs: READ_WAIT_SECONDS,
        },
      },
      { as: "bytes", signal: request.signal },
    );

    const nextSeqNum =
      batch.records.length > 0
        ? batch.records[batch.records.length - 1].seqNum + 1
        : batch.tail?.seqNum ?? seqNum;

    return json({
      records: batch.records.map((record) => ({
        seqNum: record.seqNum,
        body: bytesToBase64(record.body),
      })),
      nextSeqNum,
    });
  } catch (err) {
    if (err instanceof RangeNotSatisfiableError) {
      return json({
        records: [],
        nextSeqNum: err.tail?.seq_num ?? seqNum,
        reset: true,
      });
    }
    throw err;
  } finally {
    await stream.close().catch(() => {});
  }
}

async function findLatestSnapshot(
  docId: string,
  env: Env,
): Promise<{ url: string | null; seqNum: number }> {
  const key = snapshotKey(docId);
  const head = await env.SNAPSHOTS_BUCKET.head(key);
  if (!head) return { url: null, seqNum: 0 };

  const seqNum = parseInt(head.customMetadata?.lastSeqNum ?? "0", 10);
  return {
    url: `${env.R2_PUBLIC_BASE}/${key}`,
    seqNum,
  };
}

function streamForDoc(env: Env, docId: string) {
  const s2 = new S2({ accessToken: env.S2_ACCESS_TOKEN });
  return s2.basin(env.S2_BASIN).stream(`${STREAM_NAME_PREFIX}${docId}`);
}

function parseDocId(url: URL): string | Response {
  const docId = url.searchParams.get("doc");

  if (
    !docId ||
    docId.length === 0 ||
    docId.length > DOC_ID_MAX_LENGTH ||
    !DOC_ID_PATTERN.test(docId)
  ) {
    return json({ error: "invalid doc id" }, 400);
  }

  return docId;
}

async function rateLimit(
  request: Request,
  limiter: RateLimit,
  operation: string,
  docId: string,
): Promise<Response | null> {
  const { success } = await limiter.limit({
    key: `${operation}:${clientIp(request)}:${docId}`,
  });
  return success ? null : json({ error: "rate limited" }, 429);
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
