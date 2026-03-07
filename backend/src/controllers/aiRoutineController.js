const logger = require('../config/logger');

// ============================================================
// BASE DE EJERCICIOS POR GRUPO MUSCULAR Y EQUIPAMIENTO
// ============================================================
const EXERCISE_DB = {
  Pecho: {
    compound:  [
      { name: 'Press de banca', equipment: ['gym','dumbbells'], rest: 120, tempo: '2-1-2' },
      { name: 'Press inclinado con barra', equipment: ['gym'], rest: 120, tempo: '2-1-2' },
      { name: 'Press inclinado con mancuernas', equipment: ['gym','dumbbells'], rest: 120, tempo: '2-1-2' },
      { name: 'Fondos en paralelas', equipment: ['gym','bodyweight','home'], rest: 90, tempo: '2-1-1' },
      { name: 'Flexiones', equipment: ['bodyweight','home'], rest: 60, tempo: '2-0-1' },
    ],
    isolation: [
      { name: 'Aperturas con mancuernas', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Crossover en polea', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Pullover con mancuerna', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Espalda: {
    compound: [
      { name: 'Dominadas', equipment: ['gym','home','bodyweight'], rest: 120, tempo: '2-1-2' },
      { name: 'Remo con barra', equipment: ['gym'], rest: 120, tempo: '2-1-2' },
      { name: 'Remo con mancuerna', equipment: ['gym','dumbbells'], rest: 90, tempo: '2-1-2' },
      { name: 'Jalón al pecho', equipment: ['gym'], rest: 90, tempo: '2-1-2' },
      { name: 'Remo en polea baja', equipment: ['gym'], rest: 90, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Pull-over en polea', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Face pull', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Hiperextensiones', equipment: ['gym','home'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Piernas: {
    compound: [
      { name: 'Sentadilla', equipment: ['gym'], rest: 180, tempo: '3-1-2' },
      { name: 'Prensa de piernas', equipment: ['gym'], rest: 150, tempo: '3-1-2' },
      { name: 'Peso muerto rumano', equipment: ['gym','dumbbells'], rest: 150, tempo: '3-1-2' },
      { name: 'Zancadas con mancuernas', equipment: ['gym','dumbbells'], rest: 90, tempo: '2-1-2' },
      { name: 'Sentadilla búlgara', equipment: ['gym','dumbbells','home'], rest: 90, tempo: '2-1-2' },
      { name: 'Peso muerto', equipment: ['gym'], rest: 180, tempo: '3-0-2' },
      { name: 'Sentadilla con peso corporal', equipment: ['bodyweight','home'], rest: 60, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Extensión de cuádriceps', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Curl de isquiotibiales', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Abducción de cadera', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Hombros: {
    compound: [
      { name: 'Press militar con barra', equipment: ['gym'], rest: 120, tempo: '2-1-2' },
      { name: 'Press Arnold', equipment: ['gym','dumbbells'], rest: 90, tempo: '2-1-2' },
      { name: 'Press con mancuernas', equipment: ['gym','dumbbells'], rest: 90, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Elevaciones laterales', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Elevaciones frontales', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Pájaros en banco', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Face pull', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Bíceps: {
    compound: [
      { name: 'Curl con barra', equipment: ['gym'], rest: 75, tempo: '2-1-2' },
      { name: 'Curl con mancuernas alterno', equipment: ['gym','dumbbells'], rest: 75, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Curl martillo', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Curl en polea baja', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Curl concentrado', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Tríceps: {
    compound: [
      { name: 'Press cerrado', equipment: ['gym'], rest: 90, tempo: '2-1-2' },
      { name: 'Fondos cerrados', equipment: ['gym','home','bodyweight'], rest: 90, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Press francés', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
      { name: 'Extensión en polea alta', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Patada de tríceps', equipment: ['gym','dumbbells'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Glúteos: {
    compound: [
      { name: 'Hip thrust', equipment: ['gym'], rest: 90, tempo: '2-1-2' },
      { name: 'Sentadilla sumo', equipment: ['gym','dumbbells'], rest: 90, tempo: '2-1-2' },
      { name: 'Peso muerto rumano', equipment: ['gym','dumbbells'], rest: 90, tempo: '3-1-2' },
    ],
    isolation: [
      { name: 'Patada trasera en polea', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Puente de glúteos', equipment: ['gym','home','bodyweight'], rest: 60, tempo: '2-1-2' },
      { name: 'Abducción en máquina', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
    ],
  },
  Core: {
    compound: [
      { name: 'Plancha', equipment: ['gym','home','bodyweight'], rest: 60, tempo: 'estático' },
      { name: 'Rueda abdominal', equipment: ['gym','home'], rest: 60, tempo: '2-1-2' },
    ],
    isolation: [
      { name: 'Crunch', equipment: ['gym','home','bodyweight'], rest: 45, tempo: '2-1-2' },
      { name: 'Elevación de piernas colgado', equipment: ['gym'], rest: 60, tempo: '2-1-2' },
      { name: 'Crunch bicicleta', equipment: ['gym','home','bodyweight'], rest: 45, tempo: '1-1-1' },
      { name: 'Plancha lateral', equipment: ['gym','home','bodyweight'], rest: 45, tempo: 'estático' },
    ],
  },
  Pantorrillas: {
    compound: [
      { name: 'Elevación de talones de pie', equipment: ['gym','home','bodyweight'], rest: 60, tempo: '2-2-2' },
    ],
    isolation: [
      { name: 'Elevación de talones sentado', equipment: ['gym'], rest: 60, tempo: '2-2-2' },
      { name: 'Prensa para pantorrillas', equipment: ['gym'], rest: 60, tempo: '2-2-2' },
    ],
  },
};

// ============================================================
// SPLITS POR DÍAS
// ============================================================
const SPLITS = {
  2: [
    { day: 1, muscles: ['Pecho', 'Espalda', 'Hombros'], name: 'Full cuerpo superior' },
    { day: 2, muscles: ['Piernas', 'Glúteos', 'Core'], name: 'Full cuerpo inferior' },
  ],
  3: [
    { day: 1, muscles: ['Pecho', 'Hombros', 'Tríceps'], name: 'Empuje' },
    { day: 2, muscles: ['Espalda', 'Bíceps', 'Core'], name: 'Tirón' },
    { day: 3, muscles: ['Piernas', 'Glúteos', 'Pantorrillas'], name: 'Piernas' },
  ],
  4: [
    { day: 1, muscles: ['Pecho', 'Tríceps', 'Hombros'], name: 'Empuje' },
    { day: 2, muscles: ['Espalda', 'Bíceps', 'Core'], name: 'Tirón' },
    { day: 3, muscles: ['Piernas', 'Glúteos'], name: 'Piernas' },
    { day: 4, muscles: ['Hombros', 'Bíceps', 'Tríceps', 'Core'], name: 'Brazos y Hombros' },
  ],
  5: [
    { day: 1, muscles: ['Pecho', 'Tríceps'], name: 'Pecho y Tríceps' },
    { day: 2, muscles: ['Espalda', 'Bíceps'], name: 'Espalda y Bíceps' },
    { day: 3, muscles: ['Piernas', 'Glúteos', 'Pantorrillas'], name: 'Piernas' },
    { day: 4, muscles: ['Hombros', 'Core'], name: 'Hombros y Core' },
    { day: 5, muscles: ['Pecho', 'Espalda', 'Bíceps', 'Tríceps'], name: 'Full superior' },
  ],
  6: [
    { day: 1, muscles: ['Pecho', 'Tríceps'], name: 'Empuje A' },
    { day: 2, muscles: ['Espalda', 'Bíceps'], name: 'Tirón A' },
    { day: 3, muscles: ['Piernas', 'Glúteos'], name: 'Piernas A' },
    { day: 4, muscles: ['Hombros', 'Tríceps', 'Core'], name: 'Empuje B' },
    { day: 5, muscles: ['Espalda', 'Bíceps', 'Core'], name: 'Tirón B' },
    { day: 6, muscles: ['Piernas', 'Glúteos', 'Pantorrillas'], name: 'Piernas B' },
  ],
};

// ============================================================
// CONFIG POR OBJETIVO Y NIVEL
// ============================================================
const GOAL_CONFIG = {
  hypertrophy:   { repsCompound: '8-12',  repsIso: '12-15', setsCompound: 4, setsIso: 3, restMult: 1.0, progression: 'double progression' },
  strength:      { repsCompound: '3-6',   repsIso: '6-8',   setsCompound: 5, setsIso: 3, restMult: 1.6, progression: 'linear progression' },
  fat_loss:      { repsCompound: '12-15', repsIso: '15-20', setsCompound: 3, setsIso: 3, restMult: 0.7, progression: 'double progression' },
  endurance:     { repsCompound: '15-20', repsIso: '20-25', setsCompound: 3, setsIso: 3, restMult: 0.5, progression: 'RPE based' },
  recomposition: { repsCompound: '8-12',  repsIso: '12-15', setsCompound: 4, setsIso: 3, restMult: 0.9, progression: 'double progression' },
};

const LEVEL_CONFIG = {
  beginner:     { exercisesPerMuscle: 2, compoundFirst: true, includeIso: false },
  intermediate: { exercisesPerMuscle: 3, compoundFirst: true, includeIso: true  },
  advanced:     { exercisesPerMuscle: 4, compoundFirst: true, includeIso: true  },
};

const GOAL_NAMES = {
  hypertrophy:   'Hipertrofia',
  strength:      'Fuerza',
  fat_loss:      'Pérdida de grasa',
  endurance:     'Resistencia',
  recomposition: 'Recomposición corporal',
};

// ============================================================
// HELPER: filtrar ejercicios por equipamiento
// ============================================================
function filterByEquipment(exerciseList, equipment) {
  const equipMap = {
    gym:        ['gym'],
    dumbbells:  ['dumbbells','home','bodyweight'],
    home:       ['home','bodyweight','dumbbells'],
    bodyweight: ['bodyweight'],
  };
  const allowed = equipMap[equipment] || ['gym'];
  return exerciseList.filter(ex => ex.equipment.some(e => allowed.includes(e)));
}

// ============================================================
// HELPER: pick ejercicios sin repetir
// ============================================================
function pickExercises(muscle, equipment, count, includeIso, usedNames) {
  const db = EXERCISE_DB[muscle];
  if (!db) return [];

  const compounds  = filterByEquipment(db.compound || [], equipment).filter(e => !usedNames.has(e.name));
  const isolations = filterByEquipment(db.isolation || [], equipment).filter(e => !usedNames.has(e.name));

  const picked = [];

  // Siempre compuestos primero
  const numCompounds = includeIso ? Math.max(1, Math.ceil(count * 0.6)) : count;
  for (let i = 0; i < numCompounds && i < compounds.length; i++) {
    picked.push({ ...compounds[i], exercise_type: 'compound' });
    usedNames.add(compounds[i].name);
  }

  // Aislamientos después
  if (includeIso) {
    const numIso = count - picked.length;
    for (let i = 0; i < numIso && i < isolations.length; i++) {
      picked.push({ ...isolations[i], exercise_type: 'isolation' });
      usedNames.add(isolations[i].name);
    }
  }

  return picked;
}

// ============================================================
// POST /admin/ai-routine — Generador algorítmico profesional
// ============================================================
async function generateRoutine(req, res) {
  try {
    const {
      goal = 'hypertrophy',
      level = 'intermediate',
      days_per_week = 4,
      equipment = 'gym',
      priority_muscles = [],
    } = req.body;

    const goalCfg  = GOAL_CONFIG[goal]  || GOAL_CONFIG.hypertrophy;
    const levelCfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.intermediate;
    const split    = SPLITS[days_per_week] || SPLITS[4];

    const exercises = [];
    const usedNames = new Set();
    let orderIndex  = 0;

    for (const dayDef of split) {
      // Músculos prioritarios van primero en el día
      const orderedMuscles = [
        ...dayDef.muscles.filter(m => priority_muscles.includes(m)),
        ...dayDef.muscles.filter(m => !priority_muscles.includes(m)),
      ];

      for (const muscle of orderedMuscles) {
        // Más ejercicios para músculos prioritarios
        const isPriority = priority_muscles.includes(muscle);
        const count = isPriority
          ? Math.min(levelCfg.exercisesPerMuscle + 1, 5)
          : levelCfg.exercisesPerMuscle;

        const picked = pickExercises(muscle, equipment, count, levelCfg.includeIso, usedNames);

        for (const ex of picked) {
          const isCompound = ex.exercise_type === 'compound';
          const baseRest = isCompound
            ? Math.round(ex.rest * goalCfg.restMult)
            : Math.round((ex.rest || 60) * goalCfg.restMult);

          exercises.push({
            day_number:           dayDef.day,
            name:                 ex.name,
            muscle_group:         muscle,
            exercise_type:        ex.exercise_type,
            sets:                 isCompound ? goalCfg.setsCompound : goalCfg.setsIso,
            reps:                 isCompound ? goalCfg.repsCompound : goalCfg.repsIso,
            rest_seconds:         Math.max(30, Math.min(300, baseRest)),
            tempo:                ex.tempo || '2-1-2',
            progression_strategy: goalCfg.progression,
            notes:                isPriority ? `Músculo prioritario — máxima intensidad` : '',
            order_index:          orderIndex++,
          });
        }
      }
    }

    const levelLabel = { beginner: 'Principiante', intermediate: 'Intermedio', advanced: 'Avanzado' }[level] || level;
    const goalLabel  = GOAL_NAMES[goal] || goal;

    const routine = {
      name: `${goalLabel} — ${days_per_week} días — ${levelLabel}`,
      description: `Programa de ${goalLabel.toLowerCase()} para nivel ${levelLabel.toLowerCase()}. ${exercises.length} ejercicios distribuidos en ${days_per_week} días. ${priority_muscles.length > 0 ? `Énfasis en: ${priority_muscles.join(', ')}.` : ''}`,
      days_per_week,
      difficulty: level,
      exercises,
    };

    logger.info(`Routine generated: ${routine.name} (${exercises.length} exercises)`);
    res.json({ routine });
  } catch (err) {
    logger.error('generateRoutine error:', err);
    res.status(500).json({ error: 'Error generando rutina: ' + err.message });
  }
}

module.exports = { generateRoutine };