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
      name: z.string().min(1).max(255),
      description: z.string().optional().nullable(),
      days_per_week: z.coerce.number().int().min(1).max(7).optional(),
      difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
      exercises: z.array(z.object({
        day_number: z.coerce.number().int().min(1).max(7),
        name: z.string().min(1).max(255),
        muscle_group: z.string().optional().nullable(),
        sets: z.coerce.number().int().positive().optional(),
        reps: z.union([z.string(), z.number()]).transform(v => String(v)).optional(),
        rest_seconds: z.coerce.number().int().positive().optional(),
        weight_kg: z.coerce.number().positive().optional().nullable(),
        notes: z.string().optional().nullable(),
        video_url: z.string().optional().nullable(),
        order_index: z.coerce.number().int().optional(),
        exercise_type: z.string().optional().nullable(),
        tempo: z.string().optional().nullable(),
        progression_strategy: z.string().optional().nullable(),
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
  
  exercises: z.array(z.object({
  exercise_id: z.string().uuid().optional(),
  name: z.string().min(1),
  sets: z.array(z.object({
    reps: z.union([z.string(), z.number()]).optional(),
    weight: z.union([z.string(), z.number()]).optional(),
    completed: z.boolean().default(false),
  }))
})).optional(),
};


module.exports = { validate, schemas };
