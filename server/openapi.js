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

function jsonResponse(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}

function errorResponse(description) {
  return { description, content: { 'application/json': { schema: ERROR_SCHEMA } } };
}

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Mock Supplier API — REST API & System Integration for Non-Technical Team',
    version: '1.0.0',
    description:
      'Sandbox API untuk latihan course. Mensimulasikan Supplier System yang mengirim data stock dan production planning ke Company Internal System. Auth: X-API-Key untuk semua /api/v1/*, dan Bearer token untuk operasi tulis.',
  },
  servers: [
    { url: 'http://localhost:4010', description: 'Local sandbox (default)' },
  ],
  tags: [
    { name: 'Health', description: 'Cek status service (publik, tanpa auth).' },
    { name: 'Authentication', description: 'Ambil bearer token untuk operasi tulis.' },
    { name: 'Suppliers', description: 'Daftar supplier.' },
    { name: 'Stock (Read)', description: 'Baca data stock.' },
    { name: 'Stock (Write)', description: 'Ubah data stock (butuh bearer token).' },
    { name: 'Production Planning', description: 'Data rencana produksi.' },
    { name: 'Status Code Simulator', description: 'Simulasi status code & latency untuk latihan.' },
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
        summary: 'Daftar semua supplier',
        responses: { 200: jsonResponse('Daftar supplier', { type: 'object' }) },
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
        ],
        responses: { 200: jsonResponse('Detail supplier', { type: 'object' }), 404: errorResponse('Tidak ditemukan') },
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
        ],
        responses: { 200: jsonResponse('Daftar stock', { type: 'object' }), 404: errorResponse('Supplier tidak ditemukan') },
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
        ],
        responses: { 200: jsonResponse('Detail part', { type: 'object' }), 404: errorResponse('Tidak ditemukan') },
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
    },
    '/api/v1/suppliers/{supplierId}/production-plans': {
      get: {
        tags: ['Production Planning'],
        summary: 'Daftar production plan supplier',
        parameters: [
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['planned', 'in_progress', 'completed', 'delayed'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } },
        ],
        responses: { 200: jsonResponse('Daftar production plan', { type: 'object' }) },
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
    '/api/v1/production-plans/{planId}': {
      get: {
        tags: ['Production Planning'],
        summary: 'Detail production plan',
        parameters: [
          { name: 'planId', in: 'path', required: true, schema: { type: 'string', example: 'PLAN-001' } },
        ],
        responses: { 200: jsonResponse('Detail plan', { type: 'object' }), 404: errorResponse('Tidak ditemukan') },
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
  },
};

module.exports = { spec };
