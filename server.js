require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const { initDb } = require("./initdb");

const app = express();
const PORT = process.env.PORT || 3000;
const CAPACITE_BUS = 45;

const ADMIN_USER = process.env.ADMIN_USER || "agence";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL) {
  console.error("ERREUR: la variable d'environnement DATABASE_URL n'est pas definie.");
  console.error("Sur Render, ajoute une base PostgreSQL et connecte-la a ce service.");
}
if (!ADMIN_PASSWORD) {
  console.error("ERREUR: la variable d'environnement ADMIN_PASSWORD n'est pas definie.");
  console.error("Sans elle, l'espace admin refusera tout acces (par securite).");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

function genererCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// --- Authentification basique pour l'espace agence ---
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Espace agence non configure. Contactez l'administrateur.");
  }

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Espace Agence"');
    return res.status(401).send("Authentification requise.");
  }

  const base64Credentials = authHeader.split(" ")[1];
  const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
  const [user, password] = credentials.split(":");

  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Espace Agence"');
  return res.status(401).send("Identifiants incorrects.");
}

// Page admin protegee (avant express.static pour bien intercepter la requete)
app.get("/admin", requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Protéger aussi l'accès direct au fichier /admin.html (évite exposition via express.static)
app.get("/admin.html", requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.use(express.static(path.join(__dirname, "public")));

// --- API ---
app.get("/api/reservations", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, code, name, phone, trip_from, trip_to, trip_date, trip_time, status, created_at FROM reservations ORDER BY trip_date, trip_time"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Erreur GET /api/reservations:", err);
    res.status(500).json({ error: "Impossible de recuperer les reservations." });
  }
});

app.get("/api/reservations/code/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query(
      "SELECT name, trip_from, trip_to, trip_date, trip_time, status FROM reservations WHERE LOWER(code) = LOWER($1)",
      [code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Code de reservation introuvable." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erreur GET /api/reservations/code/:code:", err);
    res.status(500).json({ error: "Impossible de rechercher la reservation." });
  }
});

app.post("/api/reservations", async (req, res) => {
  const { name, phone, from, to, date, heure } = req.body;

  if (!name || !phone || !from || !to || !date || !heure) {
    return res.status(400).json({ error: "Tous les champs sont obligatoires." });
  }
  if (from === to) {
    return res.status(400).json({ error: "Le depart et la destination doivent etre differents." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query(
      `SELECT id FROM reservations
       WHERE trip_from = $1 AND trip_to = $2 AND trip_date = $3 AND trip_time = $4 AND status != 'annulee'
       FOR UPDATE`,
      [from, to, date, heure]
    );
    const prises = lockResult.rows.length;

    if (prises >= CAPACITE_BUS) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Ce trajet est complet pour cet horaire." });
    }

    let code = genererCode();
    let tentatives = 0;
    while (tentatives < 5) {
      const exists = await client.query("SELECT 1 FROM reservations WHERE code = $1", [code]);
      if (exists.rows.length === 0) break;
      code = genererCode();
      tentatives++;
    }

    const insertResult = await client.query(
      `INSERT INTO reservations (code, name, phone, trip_from, trip_to, trip_date, trip_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'en_attente')
       RETURNING id, code, name, phone, trip_from, trip_to, trip_date, trip_time, status, created_at`,
      [code, name.trim(), phone.trim(), from, to, date, heure]
    );

    await client.query("COMMIT");
    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur POST /api/reservations:", err);
    res.status(500).json({ error: "Impossible d'enregistrer la reservation." });
  } finally {
    client.release();
  }
});

// Protegee : seuls les agents authentifies peuvent changer un statut
app.patch("/api/reservations/:id", requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["en_attente", "confirmee", "annulee"].includes(status)) {
    return res.status(400).json({ error: "Statut invalide." });
  }

  try {
    const result = await pool.query(
      "UPDATE reservations SET status = $1 WHERE id = $2 RETURNING *",
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reservation introuvable." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erreur PATCH /api/reservations/:id:", err);
    res.status(500).json({ error: "Impossible de mettre a jour la reservation." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  try {
    await initDb(pool);
  } catch (err) {
    console.error("Erreur lors de l'initialisation de la base de donnees:", err);
  }
  app.listen(PORT, () => {
    console.log(`Serveur Express Sud Voyage demarre sur le port ${PORT}`);
  });
}

start();