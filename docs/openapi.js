'use strict';

module.exports = {
  openapi: '3.0.0',
  info: {
    title: 'Palladia API',
    version: '1.0.0',
    description: 'API per la gestione di cantieri, lavoratori, presenze e documenti.',
    contact: { email: 'palladiaofficial@gmail.com' },
  },
  servers: [
    { url: 'https://palladia-backend-production.up.railway.app', description: 'Produzione' },
    { url: 'http://localhost:3001', description: 'Sviluppo locale' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      companyId:  { type: 'apiKey', in: 'header', name: 'X-Company-Id' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error:   { type: 'string', example: 'VALIDATION_ERROR' },
          field:   { type: 'string', example: 'name' },
          message: { type: 'string', example: 'name: min 2 caratteri' },
        },
      },
      Site: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          name:        { type: 'string', example: 'Cantiere Via Roma' },
          address:     { type: 'string', nullable: true },
          status:      { type: 'string', enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'] },
          startDate:   { type: 'string', format: 'date', nullable: true },
          endDate:     { type: 'string', format: 'date', nullable: true },
          weatherRainMm:  { type: 'number', example: 10 },
          weatherWindKmh: { type: 'number', example: 50 },
        },
      },
      Worker: {
        type: 'object',
        properties: {
          id:          { type: 'string', format: 'uuid' },
          full_name:   { type: 'string', example: 'Mario Rossi' },
          fiscal_code: { type: 'string', example: 'RSSMRA80A01H501U' },
          is_active:   { type: 'boolean' },
          badge_code:  { type: 'string', example: 'A1B2C3D4E5F6G7H8' },
        },
      },
    },
  },
  security: [{ bearerAuth: [], companyId: [] }],
  paths: {
    // ── Health ───────────────────────────────────────────────────────
    '/api/health': {
      get: {
        tags: ['Infrastruttura'],
        summary: 'Health check',
        security: [],
        responses: {
          200: { description: 'Server operativo' },
          503: { description: 'Server degradato (DB non raggiungibile)' },
        },
      },
    },
    // ── Sites ────────────────────────────────────────────────────────
    '/api/v1/sites': {
      get: {
        tags: ['Cantieri'],
        summary: 'Lista cantieri della company',
        responses: {
          200: { description: 'Array di cantieri', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Site' } } } } },
          401: { description: 'Non autenticato' },
        },
      },
      post: {
        tags: ['Cantieri'],
        summary: 'Crea nuovo cantiere',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name:       { type: 'string', minLength: 2, maxLength: 200 },
                  address:    { type: 'string', nullable: true },
                  comune:     { type: 'string', nullable: true },
                  client:     { type: 'string', nullable: true },
                  status:     { type: 'string', enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'], default: 'attivo' },
                  start_date: { type: 'string', format: 'date', nullable: true },
                  end_date:   { type: 'string', format: 'date', nullable: true },
                  contract_days: { type: 'integer', minimum: 1, nullable: true },
                  days_type:  { type: 'string', enum: ['solari', 'lavorativi'], default: 'solari' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Cantiere creato' },
          400: { description: 'Dati non validi', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
          403: { description: 'Limite cantieri del piano raggiunto' },
        },
      },
    },
    '/api/v1/sites/{siteId}': {
      patch: {
        tags: ['Cantieri'],
        summary: 'Aggiorna campi cantiere',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name:             { type: 'string', maxLength: 200 },
                  status:           { type: 'string', enum: ['attivo', 'sospeso', 'ultimato', 'chiuso'] },
                  weather_rain_mm:  { oneOf: [{ type: 'number', minimum: 1, maximum: 200 }, { type: 'string', enum: [''] }, { type: 'null' }] },
                  weather_wind_kmh: { oneOf: [{ type: 'number', minimum: 10, maximum: 200 }, { type: 'string', enum: [''] }, { type: 'null' }] },
                  weather_snow:     { type: 'boolean' },
                  weather_thunderstorm: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Cantiere aggiornato' },
          400: { description: 'Dati non validi' },
          404: { description: 'Cantiere non trovato' },
        },
      },
      delete: {
        tags: ['Cantieri'],
        summary: 'Elimina cantiere (soft delete)',
        parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          204: { description: 'Eliminato' },
          404: { description: 'Non trovato' },
        },
      },
    },
    // ── Workers ──────────────────────────────────────────────────────
    '/api/v1/workers': {
      get: {
        tags: ['Lavoratori'],
        summary: 'Lista lavoratori della company',
        responses: {
          200: { description: 'Array di lavoratori', content: { 'application/json': { schema: { type: 'array', items: { '$ref': '#/components/schemas/Worker' } } } } },
        },
      },
      post: {
        tags: ['Lavoratori'],
        summary: 'Crea nuovo lavoratore',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['full_name', 'fiscal_code'],
                properties: {
                  full_name:   { type: 'string', minLength: 2, maxLength: 200 },
                  fiscal_code: { type: 'string', minLength: 16, maxLength: 16, example: 'RSSMRA80A01H501U' },
                  hire_date:   { type: 'string', format: 'date', nullable: true },
                  qualification: { type: 'string', nullable: true },
                  role:          { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Lavoratore creato' },
          400: { description: 'Dati non validi (fiscal_code errato, nome troppo corto, ecc.)' },
          409: { description: 'Fiscal code già registrato' },
        },
      },
    },
    '/api/v1/workers/{workerId}': {
      patch: {
        tags: ['Lavoratori'],
        summary: 'Aggiorna dati lavoratore',
        parameters: [{ name: 'workerId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  full_name:      { type: 'string', minLength: 2 },
                  is_active:      { type: 'boolean' },
                  tariffa_oraria: { type: 'number', minimum: 0, nullable: true },
                  hire_date:      { type: 'string', format: 'date', nullable: true },
                  qualification:  { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Aggiornato' },
          400: { description: 'Dati non validi' },
          404: { description: 'Non trovato' },
        },
      },
    },
    // ── Billing ──────────────────────────────────────────────────────
    '/api/v1/billing/status': {
      get: {
        tags: ['Abbonamento'],
        summary: 'Stato abbonamento corrente',
        responses: {
          200: {
            description: 'Stato piano',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status:    { type: 'string', enum: ['trial', 'active', 'past_due', 'canceled', 'trial_expired'] },
                    plan:      { type: 'string', enum: ['starter', 'grow', 'pro', 'business'] },
                    days_left: { type: 'integer', nullable: true },
                    site_limit:{ type: 'integer', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/billing/checkout': {
      post: {
        tags: ['Abbonamento'],
        summary: 'Crea sessione Stripe Checkout',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['plan'],
                properties: {
                  plan: { type: 'string', enum: ['starter', 'grow', 'pro', 'business'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'URL checkout Stripe', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } } } } },
          400: { description: 'Piano non valido' },
          403: { description: "Solo il proprietario può gestire l'abbonamento" },
        },
      },
    },
    // ── Presenze badge ───────────────────────────────────────────────
    '/api/v1/scan/identify': {
      post: {
        tags: ['Badge & Presenze'],
        summary: 'Identifica lavoratore via codice fiscale',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fiscal_code', 'worksite_id'],
                properties: {
                  fiscal_code:  { type: 'string', example: 'RSSMRA80A01H501U' },
                  worksite_id:  { type: 'string', format: 'uuid' },
                  pin:          { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Session token rilasciato' },
          403: { description: 'Lavoratore non assegnato al cantiere' },
          404: { description: 'Lavoratore non trovato' },
        },
      },
    },
    '/api/v1/scan/punch': {
      post: {
        tags: ['Badge & Presenze'],
        summary: 'Registra entrata/uscita (punch)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['session_token'],
                properties: {
                  session_token: { type: 'string' },
                  latitude:      { type: 'number', nullable: true },
                  longitude:     { type: 'number', nullable: true },
                  accuracy_m:    { type: 'number', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Punch registrato (ENTRY o EXIT)' },
          422: { description: 'Geofence non configurata o GPS richiesto' },
          429: { description: 'Punch troppo ravvicinato (< 60s)' },
        },
      },
    },
  },
};
