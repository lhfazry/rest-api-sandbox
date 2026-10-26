'use strict';

/**
 * openapi.js — OpenAPI 3.0 description of the mock Supplier API.
 *
 * WHY: Module "API Documentation" teaches students to READ a spec. This is the
 * machine-readable source that both /openapi.json and the /docs page use, so
 * the docs always match the real behaviour.
 *
 * The server URL is dynamic-free (relative) so it works no matter which port
 * the student uses — Swagger UI resolves it against the page origin.
 */

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'NOT_FOUND' },
        message: { type: 'string', example: 'Data yang diminta tidak ditemukan.' },
        details: { type: 'array', items: { type: 'object' }, example: [] },
      },
    },
  },
};

const STOCK_SCHEMA = {
  type: 'object',
  properties: {
    supplier_id: { type: 'string', example: 'SUP-001' },
    supplier_name: { type: 'string', example: 'PT Maju Jaya Komponen' },
    part_number: { type: 'string', example: 'MJK-BRG-6205' },
    part_name: { type: 'string', example: 'Bearing 6205 ZZ' },
    stock_quantity: { type: 'integer', example: 480 },
    uom: { type: 'string', enum: ['PCS', 'BOX', 'METER', 'SET'], example: 'PCS' },
    stock_location: { type: 'string', example: 'WH-JKT-01' },
    stock_status: { type: 'string', enum: ['available', 'low', 'out'], example: 'available' },
    unit_price: { type: 'integer', example: 45000 },
    currency: { type: 'string', example: 'IDR' },
    last_updated: { type: 'string', format: 'date-time', example: '2026-01-05T08:15:00+07:00' },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan_id: { type: 'string', example: 'PLAN-001' },
    supplier_id: { type: 'string', example: 'SUP-001' },
    part_number: { type: 'string', example: 'MJK-BRG-6205' },
    part_name: { type: 'string', example: 'Bearing 6205 ZZ' },
    production_plan: { type: 'string', example: 'Weekly Rolling Plan Q1-2026' },
    planned_quantity: { type: 'integer', example: 1000 },
    production_date: { type: 'string', format: 'date', example: '2026-02-02' },
    production_status: {
      type: 'string',
      enum: ['planned', 'in_progress', 'completed', 'delayed'],
      example: 'in_progress',
    },
    delivery_schedule: { type: 'string', format: 'date', example: '2026-02-10' },
    last_updated: { type: 'string', format: 'date-time', example: '2026-01-20T08:00:00+07:00' },
  },
};

const SUPPLIER_SCHEMA = {
  type: 'object',
  properties: {
    supplier_id: { type: 'string', example: 'SUP-001' },
    supplier_name: { type: 'string', example: 'PT Maju Jaya Komponen' },
    country: { type: 'string', example: 'Indonesia' },
    contact_email: { type: 'string', format: 'email', example: 'procurement@majujaya.co.id' },
    api_status: { type: 'string', enum: ['active', 'inactive'], example: 'active' },
  },
};

const META_SCHEMA = {
  type: 'object',
  description: 'Metadata pagination. total = jumlah baris setelah filter, sebelum pagination.',
  properties: {
    total: { type: 'integer', example: 3 },
    page: { type: 'integer', example: 1 },
    limit: { type: 'integer', example: 10 },
    total_pages: { type: 'integer', example: 1 },
  },
};

// ---- Webhook schemas ----------------------------------------------------
// Storage is in-memory only: restart server => subscriptions/deliveries hilang.

const WEBHOOK_EVENT_VALUES = [
  'stock.created',
  'stock.updated',
  'stock.deleted',
  'plan.created',
  'plan.updated',
];

const WEBHOOK_SIGNATURE_DESCRIPTION =
  'Setiap pengiriman adalah POST JSON dengan header: ' +
  'X-Sandbox-Event (nama event), X-Sandbox-Delivery (delivery_id), ' +
  'X-Sandbox-Signature: t=<unixSeconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>, ' +
  'dan User-Agent: sandbox-webhook/1.0. rawBody adalah body JSON persis seperti yang dikirim ' +
  '({ event, delivery_id, occurred_at, data }). Verifikasi: hitung HMAC-SHA256 dari string ' +
  '"<t>.<rawBody>" memakai secret subscription, lalu bandingkan dengan bagian v1.';

const WEBHOOK_RETRY_DESCRIPTION =
  'Pengiriman bersifat asinkron (tidak pernah menahan respons API): timeout 3 detik per percobaan, ' +
  'maksimal 3 percobaan, backoff 1 detik sebelum percobaan ke-2 dan 2 detik sebelum percobaan ke-3. ' +
  'HTTP 2xx => status "delivered"; non-2xx/timeout/error jaringan => dicoba ulang, lalu "failed" ' +
  'dengan pesan error setelah percobaan terakhir. Leg pengiriman dicatat di GET /api/v1/webhooks/deliveries.';

const WEBHOOK_LOCATION_HEADER = {
  Location: {
    description: 'URL subscription yang baru dibuat.',
    schema: { type: 'string', example: '/api/v1/webhooks/subscriptions/WH-001' },
  },
};

const WEBHOOK_SUBSCRIPTION_SCHEMA = {
  type: 'object',
  description: 'Subscription webhook (disimpan in-memory, hilang saat server restart).',
  properties: {
    subscription_id: { type: 'string', example: 'WH-001' },
    url: {
      type: 'string',
      format: 'uri',
      description: 'Endpoint penerima. Wajib http atau https.',
      example: 'https://example.com/webhooks/supplier',
    },
    events: {
      type: 'array',
      description: 'Event yang didaftarkan. webhook.test tidak dapat didaftarkan (hanya lewat POST .../test).',
      items: { type: 'string', enum: WEBHOOK_EVENT_VALUES },
      example: ['stock.updated', 'plan.created'],
    },
    description: { type: 'string', maxLength: 200, example: 'Notifikasi stok ke sistem internal' },
    active: { type: 'boolean', example: true },
    secret: {
      type: 'string',
      description:
        'Kunci HMAC untuk memverifikasi X-Sandbox-Signature. Ditampilkan di respons ini dan di GET list (demo only).',
      example: 'whsec_5f1c2b9a74d34c0a8e6f0b1d2c3a4e5f',
    },
    created_at: { type: 'string', format: 'date-time', example: '2026-10-26T08:00:00.000Z' },
  },
};

const WEBHOOK_DELIVERY_SCHEMA = {
  type: 'object',
  description: 'Satu percobaan pengiriman webhook (disimpan in-memory).',
  properties: {
    delivery_id: { type: 'string', example: 'DLV-001' },
    subscription_id: { type: 'string', example: 'WH-001' },
    event: {
      type: 'string',
      description: 'Event yang dikirim. "webhook.test" hanya berasal dari endpoint uji.',
      enum: [...WEBHOOK_EVENT_VALUES, 'webhook.test'],
      example: 'stock.updated',
    },
    status: { type: 'string', enum: ['pending', 'delivered', 'failed'], example: 'delivered' },
    attempts: {
      type: 'integer',
      description: 'Jumlah percobaan yang sudah dilakukan (0 = belum ada percobaan).',
      example: 1,
    },
    last_attempt_at: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      example: '2026-10-26T08:00:01.000Z',
    },
    response_status: {
      type: 'integer',
      nullable: true,
      description: 'Status HTTP dari receiver; null bila belum ada respons (timeout/error jaringan).',
      example: 204,
    },
    error: {
      type: 'string',
      nullable: true,
      description: 'Pesan kegagalan percobaan terakhir; null bila berhasil.',
      example: null,
    },
    created_at: { type: 'string', format: 'date-time', example: '2026-10-26T08:00:00.000Z' },
    payload: {
      type: 'object',
      description: 'Body yang dikirim: { event, delivery_id, occurred_at, data }.',
      properties: {
        event: { type: 'string', example: 'stock.updated' },
        delivery_id: { type: 'string', example: 'DLV-001' },
        occurred_at: { type: 'string', format: 'date-time' },
        data: { type: 'object', description: 'Snapshot record setelah mutasi (atau data uji).' },
      },
    },
  },
};

const WEBHOOK_SUBSCRIPTION_REQUEST_SCHEMA = {
  type: 'object',
  required: ['url', 'events'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Wajib URL http/https yang valid.',
      example: 'https://example.com/webhooks/supplier',
    },
    events: {
      type: 'array',
      minItems: 1,
      description: 'Minimal 1 event dari enum. webhook.test ditolak dengan 400.',
      items: { type: 'string', enum: WEBHOOK_EVENT_VALUES },
      example: ['stock.created', 'stock.updated'],
    },
    description: { type: 'string', maxLength: 200, example: 'Notifikasi stok ke sistem internal' },
  },
};

// ---- Cache validation (ETag) documentation helpers ----------------------
const IF_NONE_MATCH_PARAM = {
  name: 'If-None-Match',
  in: 'header',
  required: false,
  description:
    'ETag dari response 200 sebelumnya (boleh berupa daftar dipisah koma, atau "*"). Bila masih cocok, server membalas 304 tanpa body. Hanya berlaku untuk respons 200: respons error tidak membawa ETag dan selalu mengembalikan status aslinya (mis. 404).',
  schema: { type: 'string', example: '"fefcedd96563af2d83f2af7e48a26add12b251e1"' },
};

const ETAG_HEADERS = {
  ETag: {
    description:
      'Strong ETag = sha1(revision data + method + path + query terurut). Berubah setiap ada mutasi data. Hanya dikirim pada respons 200 (JSON) yang sukses; respons error tidak membawa ETag.',
    schema: { type: 'string', example: '"fefcedd96563af2d83f2af7e48a26add12b251e1"' },
  },
  'Cache-Control': {
    description:
      'Selalu "no-cache" pada respons 200 JSON: client wajib revalidate dengan If-None-Match.',
    schema: { type: 'string', example: 'no-cache' },
  },
};

const NOT_MODIFIED_RESPONSE = {
  description: 'Not Modified — ETag masih cocok, body kosong (tetap mengirim ETag & Cache-Control).',
  headers: ETAG_HEADERS,
};

// ---- Rate limiting documentation helpers --------------------------------
// Fixed window per API key. Headers are sent on EVERY /api/v1 response,
// including 304, 404, 406 and 429.
const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': {
    description: 'Jumlah maksimum request per API key dalam satu window.',
    schema: { type: 'integer', example: 600 },
  },
  'X-RateLimit-Remaining': {
    description:
      'Sisa kuota pada window berjalan (0 berarti request berikutnya akan dijawab 429).',
    schema: { type: 'integer', example: 599 },
  },
  'X-RateLimit-Reset': {
    description: 'Waktu reset window dalam epoch detik (UTC).',
    schema: { type: 'integer', example: 1767225600 },
  },
};

const RETRY_AFTER_HEADER = {
  description:
    'Detik sampai window direset (dibulatkan ke atas, minimal 1). Hanya pada 429 yang dihasilkan rate limiter.',
  schema: { type: 'integer', example: 42 },
};

const RATE_LIMITED_RESPONSE = {
  description:
    'Terlalu banyak request untuk API key ini (code RATE_LIMITED). Respons 429 tetap dihitung dan membawa header X-RateLimit-*; tunggu sesuai Retry-After lalu ulangi.',
  headers: { ...RATE_LIMIT_HEADERS, 'Retry-After': RETRY_AFTER_HEADER },
  content: { 'application/json': { schema: ERROR_SCHEMA } },
};

// ---- Idempotency documentation helpers ----------------------------------
const IDEMPOTENCY_KEY_PARAM = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Opsional untuk operasi tulis (POST/PUT/PATCH/DELETE). Scope = key + method + path. Request pertama dijalankan normal lalu di-cache 24 jam (status 200-499, kecuali 429/5xx). Request ulang dengan key, method, path, dan body yang SAMA tidak menjalankan handler lagi: respons cache dikirim dengan header Idempotency-Replayed: true. Body berbeda dengan key yang sama => 409 IDEMPOTENCY_KEY_REUSED.',
  schema: { type: 'string', example: 'order-2026-0001-retry-1' },
};

const IDEMPOTENCY_REPLAYED_HEADER = {
  description:
    'true bila respons ini berasal dari cache Idempotency-Key (handler tidak dijalankan lagi). Tidak dikirim pada eksekusi pertama.',
  schema: { type: 'string', enum: ['true'] },
};

const IDEMPOTENCY_CONFLICT_RESPONSE = {
  description:
    'Konflik data (mis. record sudah terdaftar) atau Idempotency-Key dipakai ulang dengan body berbeda pada method+path yang sama (code IDEMPOTENCY_KEY_REUSED; handler dan ?simulate tidak dijalankan).',
  headers: { ...RATE_LIMIT_HEADERS },
  content: { 'application/json': { schema: ERROR_SCHEMA } },
};

const RATE_LIMIT_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', example: 600 },
    window_ms: { type: 'integer', example: 60000 },
    window_started_at: {
      type: 'string',
      format: 'date-time',
      description: 'Awal window berjalan (ISO 8601).',
    },
    used: {
      type: 'integer',
      description: 'Jumlah request terpakai di window ini, termasuk request _ratelimit saat ini.',
      example: 1,
    },
    remaining: { type: 'integer', description: 'Sisa kuota (bisa 0).', example: 599 },
    reset_at: {
      type: 'string',
      format: 'date-time',
      description: 'Waktu window direset = window_started_at + window_ms (ISO 8601).',
    },
  },
};

function jsonResponse(description, schema, headers) {
  const response = { description, content: { 'application/json': { schema } } };
  if (headers) response.headers = headers;
  return response;
}

function errorResponse(description) {
  return { description, content: { 'application/json': { schema: ERROR_SCHEMA } } };
}

/** Standard read response: JSON body + pagination meta + ETag headers. */
function listResponse(description, itemSchema) {
  return jsonResponse(
    description,
    {
      type: 'object',
      properties: {
        data: { type: 'array', items: itemSchema },
        meta: META_SCHEMA,
      },
    },
    ETAG_HEADERS
  );
}

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Mock Supplier API — REST API & System Integration for Non-Technical Team',
    version: '1.0.0',
    description:
      'Sandbox API untuk latihan course. Mensimulasikan Supplier System yang mengirim data stock dan production planning ke Company Internal System. Auth: X-API-Key untuk semua /api/v1/*, dan Bearer token untuk operasi tulis. Setiap GET /api/v1/* (JSON) yang berhasil (200) mengirim ETag kuat + Cache-Control: no-cache; kirim If-None-Match untuk mendapatkan 304 tanpa body. Respons error (4xx/5xx) tidak membawa ETag dan tidak pernah dijawab 304. Rate limit fixed-window per API key (default 600 request / 60 detik) dihitung untuk semua /api/v1/* setelah API key valid: setiap respons membawa X-RateLimit-*, dan kuota habis dijawab 429 RATE_LIMITED + Retry-After. Operasi tulis menerima header Idempotency-Key (scope key+method+path, cache 24 jam): request ulang dengan body sama mengembalikan respons cache + Idempotency-Replayed: true, sedangkan body berbeda dijawab 409 IDEMPOTENCY_KEY_REUSED.',
  },
  servers: [
    { url: 'http://localhost:4010', description: 'Local sandbox (default)' },
  ],
  tags: [
    { name: 'Health', description: 'Cek status service (publik, tanpa auth).' },
    { name: 'Authentication', description: 'Ambil bearer token untuk operasi tulis.' },
    { name: 'Suppliers', description: 'Daftar supplier (filter, pagination, sort).' },
    { name: 'Stock (Read)', description: 'Baca data stock.' },
    { name: 'Stock (Global)', description: 'Daftar stock semua supplier dalam JSON atau CSV.' },
    { name: 'Stock (Write)', description: 'Ubah data stock (butuh bearer token).' },
    { name: 'Production Planning', description: 'Data rencana produksi.' },
    { name: 'Status Code Simulator', description: 'Simulasi status code & latency untuk latihan.' },
    {
      name: 'Rate Limiting',
      description:
        'Kuota request per API key (fixed window). Semua respons /api/v1 membawa header X-RateLimit-*; kuota habis => 429 + Retry-After.',
    },
    {
      name: 'Webhooks',
      description:
        'Subscription webhook + log pengiriman. Penyimpanan IN-MEMORY: restart server menghapus semua subscription dan delivery. ' +
        WEBHOOK_SIGNATURE_DESCRIPTION +
        ' ' +
        WEBHOOK_RETRY_DESCRIPTION,
    },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      BearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Error: ERROR_SCHEMA,
      Supplier: SUPPLIER_SCHEMA,
      Stock: STOCK_SCHEMA,
      ProductionPlan: PLAN_SCHEMA,
      ListMeta: META_SCHEMA,
      RateLimitStatus: RATE_LIMIT_SCHEMA,
      WebhookSubscription: WEBHOOK_SUBSCRIPTION_SCHEMA,
      WebhookDelivery: WEBHOOK_DELIVERY_SCHEMA,
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check (publik)',
        security: [],
        responses: {
          200: jsonResponse('Service sehat', {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'ok' },
              service: { type: 'string', example: 'supplier-mock-api' },
              time: { type: 'string', format: 'date-time' },
            },
          }),
        },
      },
    },
    '/auth/token': {
      post: {
        tags: ['Authentication'],
        summary: 'Ambil bearer token (publik)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['client_id', 'client_secret'],
                properties: {
                  client_id: { type: 'string', example: 'company-dashboard' },
                  client_secret: { type: 'string', example: 's3cr3t-demo' },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Token berhasil dibuat', {
            type: 'object',
            properties: {
              access_token: { type: 'string' },
              token_type: { type: 'string', example: 'Bearer' },
              expires_in: { type: 'integer', example: 3600 },
            },
          }),
          401: errorResponse('Kredensial salah'),
        },
      },
    },
    '/api/v1/suppliers': {
      get: {
        tags: ['Suppliers'],
        summary: 'Daftar supplier (filter, pagination, sort)',
        description:
          'Semua filter bersifat opsional dan bisa digabung. api_status yang tidak dikenal menghasilkan daftar kosong (bukan 400).',
        parameters: [
          {
            name: 'api_status',
            in: 'query',
            description: 'Filter status integrasi (exact). Nilai lain => hasil kosong.',
            schema: { type: 'string', enum: ['active', 'inactive'] },
          },
          {
            name: 'country',
            in: 'query',
            description: 'Filter negara (case-insensitive, exact).',
            schema: { type: 'string', example: 'Indonesia' },
          },
          {
            name: 'q',
            in: 'query',
            description: 'Pencarian substring case-insensitive pada supplier_id atau supplier_name.',
            schema: { type: 'string', example: 'elektrik' },
          },
          {
            name: 'page',
            in: 'query',
            description: 'Halaman (default 1). Nilai non-numerik dianggap 1.',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Jumlah baris per halaman (default 10, maksimal 50).',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
          {
            name: 'sort',
            in: 'query',
            description:
              'Urutkan dengan format field:asc|desc. Field tidak dikenal => urutan asli dipertahankan.',
            schema: {
              type: 'string',
              example: 'supplier_name:asc',
              enum: [
                'supplier_id:asc',
                'supplier_id:desc',
                'supplier_name:asc',
                'supplier_name:desc',
                'country:asc',
                'country:desc',
                'api_status:asc',
                'api_status:desc',
              ],
            },
          },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: listResponse('Daftar supplier terfilter + metadata pagination', SUPPLIER_SCHEMA),
          304: NOT_MODIFIED_RESPONSE,
          401: errorResponse('API key tidak ada / salah'),
        },
      },
      post: {
        tags: ['Suppliers'],
        summary: 'Tambah supplier baru',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['supplier_id', 'supplier_name'],
                properties: {
                  supplier_id: { type: 'string', example: 'SUP-004' },
                  supplier_name: { type: 'string', example: 'PT Demo Supplier' },
                  country: { type: 'string', default: 'Indonesia', example: 'Indonesia' },
                  contact_email: { type: 'string', format: 'email', example: 'demo@supplier.co.id' },
                  api_status: { type: 'string', enum: ['active', 'inactive'], default: 'active' },
                },
              },
            },
          },
        },
        responses: {
          201: jsonResponse('Supplier dibuat', {
            type: 'object',
            properties: { data: SUPPLIER_SCHEMA },
          }),
          400: errorResponse('Validasi gagal'),
          409: errorResponse('supplier_id sudah terdaftar'),
        },
      },
    },
    '/api/v1/suppliers/{supplierId}': {
      get: {
        tags: ['Suppliers'],
        summary: 'Detail satu supplier',
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: jsonResponse('Detail supplier', { type: 'object', properties: { data: SUPPLIER_SCHEMA } }, ETAG_HEADERS),
          304: NOT_MODIFIED_RESPONSE,
          404: errorResponse('Tidak ditemukan'),
        },
      },
      put: {
        tags: ['Suppliers'],
        summary: 'Full replace satu supplier',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: SUPPLIER_SCHEMA } },
        },
        responses: {
          200: jsonResponse('Supplier berhasil di-replace', { type: 'object' }),
          400: errorResponse('Validasi gagal / supplier_id berbeda dari path'),
          404: errorResponse('Supplier tidak ditemukan'),
        },
      },
      patch: {
        tags: ['Suppliers'],
        summary: 'Partial update satu supplier',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: SUPPLIER_SCHEMA } },
        },
        responses: {
          200: jsonResponse('Supplier berhasil di-patch', { type: 'object' }),
          400: errorResponse('Validasi gagal / supplier_id berbeda dari path'),
          404: errorResponse('Supplier tidak ditemukan'),
        },
      },
    },
    '/api/v1/suppliers/bulk': {
      put: {
        tags: ['Suppliers'],
        summary: 'Bulk replace supplier (update banyak supplier sekaligus, tidak membuat baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', minItems: 1, items: SUPPLIER_SCHEMA },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua supplier berhasil diganti', { type: 'object' }),
          207: jsonResponse('Bulk replace supplier selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / supplier_id duplikat'),
          404: errorResponse('Ada supplier yang tidak ditemukan (tidak ada data diubah)'),
        },
      },
      patch: {
        tags: ['Suppliers'],
        summary: 'Bulk patch supplier (update sebagian banyak supplier sekaligus, tidak membuat baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['supplier_id'],
                      properties: SUPPLIER_SCHEMA.properties,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua supplier berhasil di-patch', { type: 'object' }),
          207: jsonResponse('Bulk patch supplier selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / supplier_id duplikat'),
          404: errorResponse('Ada supplier yang tidak ditemukan (tidak ada data diubah)'),
        },
      },
    },
    '/api/v1/stock': {
      get: {
        tags: ['Stock (Global)'],
        summary: 'Daftar stock semua supplier (JSON atau CSV)',
        description:
          'Content negotiation lewat header Accept. Tanpa Accept => JSON. Bila text/csv diterima, CSV diutamakan (juga saat application/json diterima). Bila Accept tidak memuat application/json, */*, atau text/csv => 406 NOT_ACCEPTABLE. CSV: header kolom supplier_id,supplier_name,part_number,part_name,stock_quantity,uom,stock_location,stock_status,unit_price,currency,last_updated; RFC4180 (CRLF), plus X-Total-Count dan Content-Disposition. Baris CSV = baris JSON yang sudah difilter + dipaginate. ETag hanya dikirim untuk representasi JSON.',
        parameters: [
          { name: 'supplier_id', in: 'query', description: 'Filter supplier (exact).', schema: { type: 'string', example: 'SUP-001' } },
          { name: 'status', in: 'query', description: 'Filter status stock (exact).', schema: { type: 'string', enum: ['available', 'low', 'out'] } },
          { name: 'part_number', in: 'query', description: 'Filter part number (exact, case-sensitive).', schema: { type: 'string', example: 'MJK-BRG-6205' } },
          { name: 'q', in: 'query', description: 'Pencarian substring case-insensitive pada part_number atau part_name.', schema: { type: 'string', example: 'bearing' } },
          { name: 'updated_since', in: 'query', description: 'Hanya baris dengan last_updated >= nilai ini (dibandingkan sebagai timestamp).', schema: { type: 'string', format: 'date-time', example: '2026-01-20T00:00:00+07:00' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          {
            name: 'sort',
            in: 'query',
            description: 'Format field:asc|desc. Field tidak dikenal => urutan asli. Nilai numerik/string campuran tetap aman.',
            schema: { type: 'string', example: 'stock_quantity:asc', enum: ['part_number:asc', 'part_number:desc', 'stock_quantity:asc', 'stock_quantity:desc', 'last_updated:asc', 'last_updated:desc', 'supplier_id:asc', 'supplier_id:desc', 'unit_price:asc', 'unit_price:desc'] },
          },
          {
            name: 'Accept',
            in: 'header',
            description: 'application/json (default) atau text/csv. text/csv menang bila keduanya diterima.',
            schema: { type: 'string', example: 'text/csv' },
          },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: {
            description: 'Daftar stock (JSON dengan meta, atau CSV terunduh)',
            headers: {
              ...ETAG_HEADERS,
              'X-Total-Count': {
                description: 'Hanya pada CSV: jumlah baris setelah filter, sebelum pagination.',
                schema: { type: 'integer', example: 24 },
              },
              'Content-Disposition': {
                description: 'Hanya pada CSV: attachment; filename="stock-YYYYMMDD-HHmmss.csv".',
                schema: { type: 'string', example: 'attachment; filename="stock-20260125-101500.csv"' },
              },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { type: 'array', items: STOCK_SCHEMA }, meta: META_SCHEMA },
                },
              },
              'text/csv': {
                schema: { type: 'string' },
                example:
                  'supplier_id,supplier_name,part_number,part_name,stock_quantity,uom,stock_location,stock_status,unit_price,currency,last_updated\r\nSUP-001,PT Maju Jaya Komponen,MJK-BRG-6205,Bearing 6205 ZZ,480,PCS,WH-JKT-01,available,45000,IDR,2026-01-05T08:15:00+07:00\r\n',
              },
            },
          },
          304: NOT_MODIFIED_RESPONSE,
          401: errorResponse('API key tidak ada / salah'),
          406: errorResponse('Accept tidak didukung (NOT_ACCEPTABLE)'),
        },
      },
    },
    '/api/v1/suppliers/{supplierId}/stock': {
      get: {
        tags: ['Stock (Read)'],
        summary: 'Daftar stock supplier (filter, pagination, sort)',
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['available', 'low', 'out'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
          { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'sort', in: 'query', schema: { type: 'string', example: 'stock_quantity:asc' } },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: listResponse('Daftar stock supplier', STOCK_SCHEMA),
          304: NOT_MODIFIED_RESPONSE,
          404: errorResponse('Supplier tidak ditemukan'),
        },
      },
      post: {
        tags: ['Stock (Write)'],
        summary: 'Tambah satu record stock',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: STOCK_SCHEMA } },
        },
        responses: {
          201: jsonResponse('Dibuat', { type: 'object' }),
          400: errorResponse('Validasi gagal'),
          409: errorResponse('Sudah ada'),
        },
      },
    },
    '/api/v1/suppliers/{supplierId}/stock/{partNumber}': {
      get: {
        tags: ['Stock (Read)'],
        summary: 'Detail satu part',
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'partNumber', in: 'path', required: true, schema: { type: 'string' } },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: jsonResponse('Detail part', { type: 'object', properties: { data: STOCK_SCHEMA } }, ETAG_HEADERS),
          304: NOT_MODIFIED_RESPONSE,
          404: errorResponse('Tidak ditemukan'),
        },
      },
      put: {
        tags: ['Stock (Write)'],
        summary: 'Replace penuh satu part',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'partNumber', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: STOCK_SCHEMA } } },
        responses: { 200: jsonResponse('Diganti', { type: 'object' }), 400: errorResponse('Validasi gagal'), 404: errorResponse('Tidak ditemukan') },
      },
      patch: {
        tags: ['Stock (Write)'],
        summary: 'Update sebagian satu part',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'partNumber', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: STOCK_SCHEMA } } },
        responses: { 200: jsonResponse('Diupdate', { type: 'object' }), 404: errorResponse('Tidak ditemukan') },
      },
      delete: {
        tags: ['Stock (Write)'],
        summary: 'Hapus satu part',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'partNumber', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Terhapus (no content)' }, 404: errorResponse('Tidak ditemukan') },
      },
    },
    '/api/v1/suppliers/{supplierId}/stock/bulk': {
      post: {
        tags: ['Stock (Write)'],
        summary: 'Bulk upsert (integration sync)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400). partial = item valid tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { items: { type: 'array', items: STOCK_SCHEMA } },
              },
            },
          },
        },
        responses: { 201: jsonResponse('Bulk sync selesai', { type: 'object' }), 207: jsonResponse('Bulk sync selesai sebagian (mode partial)', { type: 'object' }), 400: errorResponse('Validasi gagal') },
      },
      put: {
        tags: ['Stock (Write)'],
        summary: 'Bulk replace (update banyak part sekaligus, tidak membuat baris baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: { type: 'array', minItems: 1, items: STOCK_SCHEMA },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua item berhasil diganti', { type: 'object' }),
          207: jsonResponse('Bulk replace selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / part_number duplikat'),
          404: errorResponse('Ada part yang tidak ditemukan (tidak ada data diubah)'),
        },
      },
      patch: {
        tags: ['Stock (Write)'],
        summary: 'Bulk patch (update sebagian banyak part sekaligus, tidak membuat baris baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['part_number'],
                      properties: STOCK_SCHEMA.properties,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua item berhasil di-patch', { type: 'object' }),
          207: jsonResponse('Bulk patch selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / part_number duplikat'),
          404: errorResponse('Ada part yang tidak ditemukan (tidak ada data diubah)'),
        },
      },
    },
    '/api/v1/suppliers/{supplierId}/production-plans': {
      get: {
        tags: ['Production Planning'],
        summary: 'Daftar production plan supplier (filter, pagination, sort)',
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'delayed'] } },
          { name: 'updated_since', in: 'query', description: 'Hanya plan dengan last_updated >= nilai ini (timestamp).', schema: { type: 'string', format: 'date-time', example: '2026-01-01T00:00:00+07:00' } },
          {
            name: 'sort',
            in: 'query',
            description: 'Format field:asc|desc. Field tidak dikenal => urutan asli.',
            schema: { type: 'string', example: 'planned_quantity:desc', enum: ['plan_id:asc', 'plan_id:desc', 'production_date:asc', 'production_date:desc', 'delivery_schedule:asc', 'delivery_schedule:desc', 'last_updated:asc', 'last_updated:desc', 'planned_quantity:asc', 'planned_quantity:desc'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: listResponse('Daftar production plan supplier', PLAN_SCHEMA),
          304: NOT_MODIFIED_RESPONSE,
          404: errorResponse('Supplier tidak ditemukan'),
        },
      },
      post: {
        tags: ['Production Planning'],
        summary: 'Tambah production plan',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: PLAN_SCHEMA } } },
        responses: { 201: jsonResponse('Dibuat', { type: 'object' }), 400: errorResponse('Validasi gagal') },
      },
    },
    '/api/v1/suppliers/{supplierId}/production-plans/bulk': {
      put: {
        tags: ['Production Planning'],
        summary: 'Bulk replace production plan (update banyak plan sekaligus, tidak membuat baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: [
                        'plan_id',
                        'part_number',
                        'part_name',
                        'production_plan',
                        'planned_quantity',
                        'production_date',
                        'production_status',
                        'delivery_schedule',
                      ],
                      properties: {
                        plan_id: { type: 'string', example: 'PLAN-001' },
                        ...PLAN_SCHEMA.properties,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua production plan berhasil diganti', { type: 'object' }),
          207: jsonResponse('Bulk replace production plan selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / plan_id duplikat'),
          404: errorResponse('Ada plan yang tidak ditemukan untuk supplier ini (tidak ada data diubah)'),
        },
      },
      patch: {
        tags: ['Production Planning'],
        summary: 'Bulk patch production plan (update sebagian banyak plan sekaligus, tidak membuat baru)',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string', example: 'SUP-001' } },
          {
            name: 'mode',
            in: 'query',
            required: false,
            description: 'strict (default) = all-or-nothing (400/404, tidak ada data diubah). partial = item valid & ada tetap diproses, sisanya dilaporkan (207).',
            schema: { type: 'string', enum: ['strict', 'partial'], default: 'strict' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['plan_id'],
                      properties: {
                        plan_id: { type: 'string', example: 'PLAN-001' },
                        ...PLAN_SCHEMA.properties,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Semua production plan berhasil di-patch', { type: 'object' }),
          207: jsonResponse('Bulk patch production plan selesai sebagian (mode partial)', { type: 'object' }),
          400: errorResponse('Validasi gagal / plan_id duplikat'),
          404: errorResponse('Ada plan yang tidak ditemukan untuk supplier ini (tidak ada data diubah)'),
        },
      },
    },
    '/api/v1/production-plans': {
      get: {
        tags: ['Production Planning'],
        summary: 'Daftar production plan semua supplier (filter, pagination, sort)',
        parameters: [
          { name: 'supplier_id', in: 'query', description: 'Filter supplier (exact).', schema: { type: 'string', example: 'SUP-001' } },
          { name: 'status', in: 'query', description: 'Filter production_status (exact).', schema: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'delayed'] } },
          { name: 'part_number', in: 'query', description: 'Filter part number (exact).', schema: { type: 'string', example: 'MJK-BRG-6205' } },
          { name: 'q', in: 'query', description: 'Pencarian substring case-insensitive pada part_number atau part_name.', schema: { type: 'string', example: 'bearing' } },
          { name: 'updated_since', in: 'query', description: 'Hanya plan dengan last_updated >= nilai ini (timestamp).', schema: { type: 'string', format: 'date-time', example: '2026-01-01T00:00:00+07:00' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
          {
            name: 'sort',
            in: 'query',
            description: 'Format field:asc|desc. Field tidak dikenal => urutan asli.',
            schema: { type: 'string', example: 'production_date:desc', enum: ['plan_id:asc', 'plan_id:desc', 'production_date:asc', 'production_date:desc', 'delivery_schedule:asc', 'delivery_schedule:desc', 'last_updated:asc', 'last_updated:desc', 'planned_quantity:asc', 'planned_quantity:desc'] },
          },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: listResponse('Daftar production plan semua supplier', PLAN_SCHEMA),
          304: NOT_MODIFIED_RESPONSE,
          401: errorResponse('API key tidak ada / salah'),
        },
      },
    },
    '/api/v1/production-plans/{planId}': {
      get: {
        tags: ['Production Planning'],
        summary: 'Detail production plan',
        parameters: [
          { name: 'planId', in: 'path', required: true, schema: { type: 'string', example: 'PLAN-001' } },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: jsonResponse('Detail plan', { type: 'object', properties: { data: PLAN_SCHEMA } }, ETAG_HEADERS),
          304: NOT_MODIFIED_RESPONSE,
          404: errorResponse('Tidak ditemukan'),
        },
      },
      put: {
        tags: ['Production Planning'],
        summary: 'Full replace satu production plan',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'planId', in: 'path', required: true, schema: { type: 'string', example: 'PLAN-001' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: PLAN_SCHEMA } } },
        responses: {
          200: jsonResponse('Production plan berhasil di-replace', { type: 'object' }),
          400: errorResponse('Validasi gagal / plan_id atau supplier_id berbeda'),
          404: errorResponse('Production plan tidak ditemukan'),
        },
      },
      patch: {
        tags: ['Production Planning'],
        summary: 'Partial update satu production plan',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          { name: 'planId', in: 'path', required: true, schema: { type: 'string', example: 'PLAN-001' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: PLAN_SCHEMA } } },
        responses: {
          200: jsonResponse('Production plan berhasil di-patch', { type: 'object' }),
          400: errorResponse('Validasi gagal / plan_id atau supplier_id berbeda'),
          404: errorResponse('Production plan tidak ditemukan'),
        },
      },
    },
    '/api/v1/_simulate/{code}': {
      get: {
        tags: ['Status Code Simulator'],
        summary: 'Kembalikan status code tertentu dengan error body standar',
        parameters: [
          { name: 'code', in: 'path', required: true, schema: { type: 'integer', enum: [400, 401, 403, 404, 429, 500] } },
        ],
        responses: {
          400: errorResponse('400 contoh'),
          401: errorResponse('401 contoh'),
          403: errorResponse('403 contoh'),
          404: errorResponse('404 contoh'),
          429: errorResponse('429 contoh'),
          500: errorResponse('500 contoh'),
        },
      },
    },
    '/api/v1/_ratelimit': {
      get: {
        tags: ['Rate Limiting'],
        summary: 'Status kuota rate limit untuk API key ini',
        description:
          'Menampilkan window berjalan untuk API key pemanggil. Request ini ikut dihitung, jadi "used" sudah termasuk dirinya. Window dimulai pada request pertama dan reset_at = window_started_at + window_ms. Respons 429 hanya terjadi bila kuota sudah habis sebelum endpoint ini dicapai.',
        responses: {
          200: jsonResponse(
            'Status window rate limit',
            { type: 'object', properties: { data: RATE_LIMIT_SCHEMA } },
            RATE_LIMIT_HEADERS
          ),
          401: errorResponse('API key tidak ada / salah'),
        },
      },
    },
    '/api/v1/webhooks/subscriptions': {
      get: {
        tags: ['Webhooks'],
        summary: 'Daftar subscription webhook',
        description:
          'Menampilkan semua subscription beserta secret-nya (sengaja, untuk latihan verifikasi signature). ' +
          'Penyimpanan in-memory: hilang saat server restart.',
        parameters: [IF_NONE_MATCH_PARAM],
        responses: {
          200: jsonResponse(
            'Daftar subscription webhook',
            {
              type: 'object',
              properties: {
                data: { type: 'array', items: WEBHOOK_SUBSCRIPTION_SCHEMA },
                meta: {
                  type: 'object',
                  properties: { total: { type: 'integer', example: 1 } },
                },
              },
            },
            ETAG_HEADERS
          ),
          304: NOT_MODIFIED_RESPONSE,
          401: errorResponse('API key tidak ada / salah'),
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Daftarkan subscription webhook',
        description:
          'Membuat subscription baru (dan mengembalikan secret HMAC-nya). ' +
          'Validasi: url wajib http/https yang valid, events minimal 1 dari enum, description opsional maksimal 200 karakter. ' +
          'Event "webhook.test" ditolak di sini karena hanya dihasilkan endpoint uji. ' +
          WEBHOOK_SIGNATURE_DESCRIPTION +
          ' ' +
          WEBHOOK_RETRY_DESCRIPTION,
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: WEBHOOK_SUBSCRIPTION_REQUEST_SCHEMA } },
        },
        responses: {
          201: jsonResponse(
            'Subscription dibuat',
            { type: 'object', properties: { data: WEBHOOK_SUBSCRIPTION_SCHEMA } },
            WEBHOOK_LOCATION_HEADER
          ),
          400: errorResponse(
            'Validasi gagal: url bukan http/https, events kosong / berisi event tidak dikenal (termasuk webhook.test), atau description terlalu panjang (details[] berisi field + issue)'
          ),
          401: errorResponse('API key atau bearer token tidak ada / salah'),
          403: errorResponse('Bearer token readonly tidak boleh menulis'),
        },
      },
    },
    '/api/v1/webhooks/subscriptions/{subscriptionId}': {
      delete: {
        tags: ['Webhooks'],
        summary: 'Hapus subscription webhook',
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: 'subscriptionId',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'WH-001' },
          },
        ],
        responses: {
          204: { description: 'Subscription dihapus. Body kosong.' },
          401: errorResponse('API key atau bearer token tidak ada / salah'),
          403: errorResponse('Bearer token readonly tidak boleh menulis'),
          404: errorResponse('Subscription tidak ditemukan'),
        },
      },
    },
    '/api/v1/webhooks/subscriptions/{subscriptionId}/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Kirim event uji webhook.test ke subscription',
        description:
          'Membuat satu delivery sintetis (event "webhook.test", data { message: "Test delivery", subscription_id }) ' +
          'dan mengirimkannya secara asinkron ke URL subscription. Respons 202 langsung dikembalikan tanpa menunggu receiver. ' +
          WEBHOOK_SIGNATURE_DESCRIPTION,
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: 'subscriptionId',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'WH-001' },
          },
        ],
        responses: {
          202: jsonResponse('Delivery uji diantrikan', {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  delivery_id: { type: 'string', example: 'DLV-001' },
                  event: { type: 'string', enum: ['webhook.test'], example: 'webhook.test' },
                },
              },
            },
          }),
          401: errorResponse('API key atau bearer token tidak ada / salah'),
          403: errorResponse('Bearer token readonly tidak boleh menulis'),
          404: errorResponse('Subscription tidak ditemukan'),
        },
      },
    },
    '/api/v1/webhooks/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'Log pengiriman webhook (terbaru lebih dulu)',
        description:
          'Menampilkan delivery beserta attempts, last_attempt_at, response_status, error dan payload. ' +
          'Urutan terbaru lebih dulu. Filter status yang tidak dikenal menghasilkan daftar kosong (bukan 400). ' +
          'Pagination sama dengan endpoint list lain: limit default 10, maksimal 50, total_pages 0 saat kosong. ' +
          WEBHOOK_RETRY_DESCRIPTION,
        parameters: [
          {
            name: 'subscription_id',
            in: 'query',
            description: 'Filter berdasarkan subscription_id (exact).',
            schema: { type: 'string', example: 'WH-001' },
          },
          {
            name: 'status',
            in: 'query',
            description: 'Filter status delivery. Nilai lain => hasil kosong.',
            schema: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
          },
          {
            name: 'page',
            in: 'query',
            description: 'Halaman (default 1). Nilai non-numerik dianggap 1.',
            schema: { type: 'integer', minimum: 1, default: 1 },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Jumlah baris per halaman (default 10, maksimal 50).',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
          IF_NONE_MATCH_PARAM,
        ],
        responses: {
          200: listResponse('Log pengiriman webhook', WEBHOOK_DELIVERY_SCHEMA),
          304: NOT_MODIFIED_RESPONSE,
          401: errorResponse('API key tidak ada / salah'),
        },
      },
    },
  },
};

// ---- Decorate every /api/v1 operation -----------------------------------
// Kept programmatic so a new endpoint automatically inherits the cross-cutting
// contract: rate-limit headers on every response, a documented 429, and (for
// writes) the Idempotency-Key parameter, replay header and 409 reuse case.
// /health, /auth/token, /openapi.json and /docs are intentionally untouched.
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];

function decorateApiOperations(apiSpec) {
  for (const [pathname, item] of Object.entries(apiSpec.paths)) {
    if (!pathname.startsWith('/api/v1')) continue;

    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const isWrite = WRITE_METHODS.includes(method);
      operation.responses = operation.responses || {};

      if (isWrite) {
        operation.parameters = [...(operation.parameters || []), IDEMPOTENCY_KEY_PARAM];
      }

      for (const [status, response] of Object.entries(operation.responses)) {
        response.headers = { ...RATE_LIMIT_HEADERS, ...(response.headers || {}) };
        const code = Number(status);
        // A replay is only possible for cacheable statuses (2xx-4xx, never 429).
        if (isWrite && code >= 200 && code <= 499 && code !== 429) {
          response.headers['Idempotency-Replayed'] = IDEMPOTENCY_REPLAYED_HEADER;
        }
      }

      operation.responses[429] = RATE_LIMITED_RESPONSE;

      if (isWrite) {
        operation.responses[409] = IDEMPOTENCY_CONFLICT_RESPONSE;
      }
    }
  }
}

decorateApiOperations(spec);

module.exports = { spec };
