// Initialise la table des reservations dans la base PostgreSQL.
// Se lance automatiquement au demarrage du serveur (voir server.js),
// donc pas besoin de l'executer a la main normalement.

const { Pool } = require("pg");

async function initDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservations (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      trip_from TEXT NOT NULL,
      trip_to TEXT NOT NULL,
      trip_date DATE NOT NULL,
      trip_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'en_attente',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reservations_trip
    ON reservations (trip_date, trip_from, trip_to, trip_time);
  `);

  console.log("Base de donnees initialisee (table reservations prete).");
}

module.exports = { initDb };

// Permet aussi de lancer ce fichier seul avec: node initdb.js
if (require.main === module) {
  require("dotenv").config();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  initDb(pool)
    .then(() => pool.end())
    .catch((err) => {
      console.error("Erreur d'initialisation:", err);
      process.exit(1);
    });
}