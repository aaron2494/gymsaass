const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      req.body = parsed.body || req.body;
      req.query = parsed.query || req.query;
      req.params = parsed.params || req.params;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Datos inválidos',
          details: err.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      next(err);
    }
  };
}

// ============================================================
// Schemas de validación
// ============================================================
const schemas = {
  createTenant: z.object({
    body: z.object({
      name: z.string().min(2).max(255),
      email: z.string().email(),
      phone: z.string().optional(),
      address: z.string().optional(),
      monthly_fee: z.number().positive().optional(),
    }),
  }),

  createUser: z.object({
    body: z.object({
      email: z.string().email(),
      full_name: z.string().min(2).max(255),
      phone: z.string().optional(),
      password: z.string().min(6),
      role: z.enum(['admin', 'client']),
    }),
  }),

  createRoutine: z.object({
    body: z.object({
      name: z.string().min(2).max(255),
      description: z.string().optional(),
      days_per_week: z.number().int().min(1).max(7).optional(),
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
      exercises: z.array(z.object({
        day_number: z.number().int().min(1).max(7),
        name: z.string().min(2).max(255),
        muscle_group: z.string().optional(),
        sets: z.number().int().positive().optional(),
        reps: z.string().optional(),
        rest_seconds: z.number().int().positive().optional(),
        weight_kg: z.number().positive().optional(),
        notes: z.string().optional(),
        order_index: z.number().int().optional(),
      })).optional(),
    }),
  }),

  assignRoutine: z.object({
    body: z.object({
      user_id: z.string().uuid(),
      routine_id: z.string().uuid(),
      notes: z.string().optional(),
    }),
  }),

  createSubscription: z.object({
    body: z.object({
      user_id: z.string().uuid(),
      amount: z.number().positive(),
      currency: z.string().default('ARS'),
    }),
  }),

  updateTenantStatus: z.object({
    body: z.object({
      status: z.enum(['active', 'inactive', 'blocked']),
      reason: z.string().optional(),
    }),
    params: z.object({
      tenantId: z.string().uuid(),
    }),
  }),
};

module.exports = { validate, schemas };
