import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import { neon } from "@neondatabase/serverless";

// Carga el mismo .env que usa tu server.js (un nivel arriba de esta carpeta)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// --------- EDITÁ ESTOS DOS VALORES ---------
const ADMIN_EMAIL = "ivanezequieljure1997@hotmail.com";
const ADMIN_PASSWORD = "AdminMatesBIB";
// --------------------------------------------

async function crearAdmin() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("⚠️ Falta DATABASE_URL en el .env");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  try {
    const rows = await sql`
      INSERT INTO admins (email, password_hash)
      VALUES (${ADMIN_EMAIL.trim().toLowerCase()}, ${passwordHash})
      RETURNING id, email
    `;
    console.log("✅ Admin creado con éxito:");
    console.log(rows[0]);
  } catch (err) {
    if (err.message?.includes("duplicate key")) {
      console.error(`⚠️ Ya existe un admin con el email ${ADMIN_EMAIL}`);
    } else {
      console.error("Error al crear el admin:", err.message);
    }
  }
}

crearAdmin();