import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";
import { neon } from "@neondatabase/serverless";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import crypto from "crypto";

// Obtener la ruta absoluta del directorio actual (compatibilidad con ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar explícitamente el archivo .env desde la raíz general del proyecto
dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
const PORT = process.env.PORT || 3001;

// Conexión a Neon PostgreSQL
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("⚠️ FALTA LA VARIABLE DATABASE_URL EN EL ARCHIVO .ENV");
}
const sql = neon(databaseUrl || "");

// Configuración de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configuración de Multer para manejar los archivos en memoria temporalmente
const upload = multer({ storage: multer.memoryStorage() });

// Secreto para firmar/verificar JWT (obligatorio, sin valor por defecto inseguro)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("⚠️ FALTA LA VARIABLE JWT_SECRET EN EL ARCHIVO .ENV");
}

const rawFrontendUrl = process.env.SITE_URL || process.env.FRONTEND_URL || "https://bibmates.com.ar";
const SITE_URL = rawFrontendUrl.startsWith("http")
  ? rawFrontendUrl.replace(/\/$/, "")
  : `https://${rawFrontendUrl.replace(/\/$/, "")}`;

const BACKEND_URL = (process.env.BACKEND_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://bibmates.com.ar",
  "https://www.bibmates.com.ar",
  SITE_URL,
].filter(Boolean);

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      const esVercelPreview = origin && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
      if (!origin || allowedOrigins.includes(origin) || esVercelPreview) {
        callback(null, true);
      } else {
        callback(new Error("No autorizado por CORS"));
      }
    },
    credentials: true,
  })
);

// Límite general: 300 pedidos cada 15 min por IP
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiterGeneral);

// Límite más estricto en las rutas de pago
const limiterPagos = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos, esperá unos minutos y volvé a intentar." },
});
app.use("/api/payment", limiterPagos);

// Límite estricto en el login para dificultar ataques de fuerza bruta
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos de inicio de sesión, esperá unos minutos." },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || "" });

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function obtenerDatosTransferencia() {
  try {
    const rows = await sql`SELECT * FROM site_settings LIMIT 1`;
    const data = rows[0];
    return {
      cbu: data?.transferencia_cbu || data?.bank_cbu || process.env.CVU || process.env.BANK_CBU || "No especificado",
      alias: data?.transferencia_alias || data?.bank_alias || process.env.ALIAS || process.env.BANK_ALIAS || "No especificado",
      titular: data?.transferencia_titular || data?.bank_holder || process.env.TITULAR_CUENTA || process.env.BANK_HOLDER || "No especificado",
      banco: data?.bank_name || process.env.BUSINESS_NAME || process.env.BANK_NAME || "No especificado",
    };
  } catch (err) {
    return {
      cbu: process.env.CVU || process.env.BANK_CBU || "No especificado",
      alias: process.env.ALIAS || process.env.BANK_ALIAS || "No especificado",
      titular: process.env.TITULAR_CUENTA || process.env.BANK_HOLDER || "No especificado",
      banco: process.env.BUSINESS_NAME || process.env.BANK_NAME || "No especificado",
    };
  }
}

// Función de seguridad para calcular el precio real desde Neon
async function calcularItemsConPrecioReal(items, paymentMethod) {
  const verifiedItems = [];
  let totalProductos = 0;

  for (const item of items) {
    const rows = await sql`
      SELECT id, name, price, price_cash 
      FROM productos 
      WHERE id = ${item.id} 
      LIMIT 1
    `;
    const dbProduct = rows[0];

    if (!dbProduct) {
      throw new Error(`Producto con ID ${item.id} no encontrado en la base de datos.`);
    }

    const basePrice = Number(dbProduct.price) || 0;
    const cashPrice = dbProduct.price_cash && Number(dbProduct.price_cash) > 0 ? Number(dbProduct.price_cash) : basePrice;

    const unitPrice = paymentMethod === "transferencia" ? cashPrice : basePrice;
    const quantity = Number(item.quantity) || 1;

    totalProductos += unitPrice * quantity;

    verifiedItems.push({
      id: dbProduct.id,
      name: dbProduct.name,
      quantity: quantity,
      price: unitPrice,
      originalPrice: basePrice,
      price_cash: cashPrice,
    });
  }

  return { verifiedItems, totalProductos };
}

async function enviarEmailNotificacion(order) {
  if (!process.env.EMAIL_USER) return;

  const productosTexto = order.productos
    .map((p) => `- ${p.name} (x${p.quantity}): $${(p.price * p.quantity).toLocaleString("es-AR")}`)
    .join("\n");

  const adminEmail = process.env.EMAIL_ADMIN || process.env.ADMIN_EMAIL || process.env.EMAIL_USER;

  const mailOptions = {
    from: `"${process.env.BUSINESS_NAME || "BIB Mates"}" <${process.env.EMAIL_USER}>`,
    to: adminEmail,
    subject: `Nuevo pedido #${order.identificador} - ${order.nombre_del_cliente}`,
    text: `
¡Nuevo pedido recibido!

Número de Orden: #${order.identificador}
Cliente: ${order.nombre_del_cliente}
DNI: ${order.dni}
Teléfono: ${order.telefono}
Email: ${order.email}
Dirección: ${order.direccion}, ${order.ciudad}, ${order.provincia} (CP: ${order.codigo_postal})

Método de Pago: ${order.metodo_pago.toUpperCase()}
Estado: ${order.estado}

PRODUCTOS:
${productosTexto}

Envío: $${Number(order.costo_de_envio).toLocaleString("es-AR")}
Descuento: -$${Number(order.descuento || 0).toLocaleString("es-AR")}
TOTAL FINAL: $${Number(order.total).toLocaleString("es-AR")}
    `,
  };

  return transporter.sendMail(mailOptions);
}

async function enviarEmailConfirmacionCliente(order) {
  if (!process.env.EMAIL_USER || !order.email) return;

  const mailOptions = {
    from: `"${process.env.BUSINESS_NAME || "BIB Mates"}" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Confirmación de Pedido #${order.identificador}`,
    text: `
Hola ${order.nombre_del_cliente},

¡Gracias por tu compra en ${process.env.BUSINESS_NAME || "BIB Mates"}! Tu pedido #${order.identificador} ha sido registrado exitosamente.

Total: $${Number(order.total).toLocaleString("es-AR")}
Método de Pago: Mercado Pago / Tarjeta
    `,
  };

  return transporter.sendMail(mailOptions);
}

async function enviarEmailTransferencia(order, datosTransferencia) {
  if (!process.env.EMAIL_USER || !order.email) return;

  const mailOptions = {
    from: `"${process.env.BUSINESS_NAME || "BIB Mates"}" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Datos para Transferencia - Orden #${order.identificador}`,
    text: `
Hola ${order.nombre_del_cliente},

Gracias por tu compra en ${process.env.BUSINESS_NAME || "BIB Mates"}. Realiza la transferencia para completar tu pedido:

Monto Total: $${Number(order.total).toLocaleString("es-AR")}

Datos Bancarios:
- Banco / Cuenta: ${datosTransferencia.banco}
- Titular: ${datosTransferencia.titular}
- CBU/CVU: ${datosTransferencia.cbu}
- Alias: ${datosTransferencia.alias}

Por favor, responde a este email con el comprobante de pago e indicando el N° de Orden: #${order.identificador}.
    `,
  };

  return transporter.sendMail(mailOptions);
}

// ==========================================================
// 1. RUTA DE SALUD (Healthcheck)
// ==========================================================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// ==========================================================
// RUTA DE FAVORITOS (Añadida para solucionar el error 404)
// ==========================================================
app.post("/api/productos/favoritos", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.json([]);
    }

    const rows = await sql`
      SELECT * FROM productos 
      WHERE id = ANY(${ids})
    `;

    res.json(rows);
  } catch (err) {
    console.error("Error al obtener favoritos:", err);
    res.status(500).json({ error: "Error al obtener favoritos" });
  }
});

// ==========================================================
// 2. RUTAS GENÉRICAS REST PARA EXPONER LA BASE DE DATOS
// ==========================================================
app.get("/api/:tabla", async (req, res) => {
  const { tabla } = req.params;
  const tablasPermitidas = [
    "productos", 
    "categorias", 
    "subcategorias", 
    "site_settings", 
    "site-settings",
    "faqs", 
    "coupons",
    "tags",
    "orders",
    "resenas",
    "grabados",
    "carritos_abandonados"
  ];

  if (!tablasPermitidas.includes(tabla)) {
    return res.status(400).json({ error: "Tabla no permitida" });
  }

  try {
    if (tabla === "site_settings") {
      const rows = await sql`SELECT * FROM site_settings LIMIT 1`;
      return res.json(rows[0] || { id: 1 });
    }

        if (tabla === "productos") {
      const { destacado, categoria_id } = req.query;

      if (destacado === "true") {
        const rows = await sql`
          SELECT 
            p.*,
            COALESCE(imgs.urls, '[]'::json) AS imagenes_secundarias
          FROM productos p
          LEFT JOIN LATERAL (
            SELECT json_agg(url ORDER BY id) AS urls
            FROM imagenes_secundarias
            WHERE producto_id = p.id
          ) imgs ON true
          WHERE p.destacado = true
          ORDER BY p.id DESC
        `;
        return res.json(rows);
      }

      if (categoria_id) {
        const rows = await sql`
          SELECT 
            p.*,
            COALESCE(imgs.urls, '[]'::json) AS imagenes_secundarias
          FROM productos p
          LEFT JOIN LATERAL (
            SELECT json_agg(url ORDER BY id) AS urls
            FROM imagenes_secundarias
            WHERE producto_id = p.id
          ) imgs ON true
          WHERE p.categoria_id = ${categoria_id}
          ORDER BY p.id ASC
        `;
        return res.json(rows);
      }

      const rows = await sql`
        SELECT 
          p.*,
          COALESCE(imgs.urls, '[]'::json) AS imagenes_secundarias
        FROM productos p
        LEFT JOIN LATERAL (
          SELECT json_agg(url ORDER BY id) AS urls
          FROM imagenes_secundarias
          WHERE producto_id = p.id
        ) imgs ON true
        ORDER BY p.created_at DESC
      `;
      return res.json(rows);
    }

    if (tabla === "categorias") {
      const rows = await sql`SELECT * FROM categorias ORDER BY nombre ASC`;
      return res.json(rows);
    }

    if (tabla === "subcategorias") {
      const { categoria_id } = req.query;
      if (categoria_id) {
        const rows = await sql`SELECT * FROM subcategorias WHERE categoria_id = ${categoria_id} ORDER BY id ASC`;
        return res.json(rows);
      }
      const rows = await sql`SELECT * FROM subcategorias ORDER BY id ASC`;
      return res.json(rows);
    }

    if (tabla === "faqs") {
      try {
        const rows = await sql`
          SELECT 
            id, 
            question AS pregunta, 
            answer AS respuesta, 
            question, 
            answer, 
            created_at 
          FROM faqs 
          ORDER BY id ASC
        `;
        return res.json(rows);
      } catch (faqErr) {
        console.warn("Tabla 'faqs' no encontrada o vacía en Neon, retornando lista vacía.");
        return res.json([]);
      }
    }

    if (tabla === "coupons") {
      const rows = await sql`SELECT * FROM coupons ORDER BY id DESC`;
      return res.json(rows);
    }

    if (tabla === "orders") {
      const rows = await sql`SELECT * FROM orders ORDER BY identificador DESC`;
      return res.json(rows);
    }

    if (tabla === "resenas") {
      const rows = await sql`SELECT * FROM resenas ORDER BY created_at DESC`;
      return res.json(rows);
    }

    if (tabla === "grabados") {
      const rows = await sql`SELECT * FROM grabados ORDER BY id DESC`;
      return res.json(rows);
    }

    if (tabla === "carritos_abandonados") {
      const { recuperado } = req.query;
      if (recuperado === "true" || recuperado === "false") {
        const rows = await sql`
          SELECT * FROM carritos_abandonados 
          WHERE recuperado = ${recuperado === "true"} 
          ORDER BY created_at DESC
        `;
        return res.json(rows);
      }
      const rows = await sql`SELECT * FROM carritos_abandonados ORDER BY created_at DESC`;
      return res.json(rows);
    }

    const rows = await sql`SELECT * FROM ${sql(tabla)}`;
    return res.json(rows);

  } catch (err) {
    console.error(`Error al obtener ${tabla}:`, err);
    res.status(200).json([]);
  }
});

app.post("/api/coupons/validate", async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "El código es requerido" });
  }

  try {
    const rows = await sql`
      SELECT * FROM coupons 
      WHERE code = ${code.toUpperCase().trim()} AND is_active = true 
      LIMIT 1
    `;
    const coupon = rows[0];

    if (!coupon) {
      return res.status(404).json({ error: "Cupón no válido o inactivo" });
    }

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: "El cupón ha expirado" });
    }

    res.json({
      code: coupon.code,
      discount_percentage: coupon.discount_percentage,
    });
  } catch (err) {
    console.error("Error al validar cupón:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ==========================================================
// RUTA DE AUTENTICACIÓN (LOGIN)
// ==========================================================
app.post("/api/auth/login", limiterLogin, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Correo y contraseña requeridos" });
  }

  if (!JWT_SECRET) {
    console.error("Intento de login con JWT_SECRET no configurado");
    return res.status(500).json({ error: "Error interno del servidor" });
  }

  try {
    const rows = await sql`SELECT * FROM admins WHERE email = ${email.trim().toLowerCase()} LIMIT 1`;
    const admin = rows[0];

    if (!admin) {
      return res.status(401).json({ error: "Correo o contraseña incorrectos" });
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Correo o contraseña incorrectos" });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({ token });

  } catch (err) {
    console.error("Error en el login del servidor:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Middleware de verificación para Rutas Admin
function verificarAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!JWT_SECRET) {
    console.error("Intento de verificación con JWT_SECRET no configurado");
    return res.status(500).json({ error: "Error interno del servidor" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// ==========================================================
// RUTAS ADMIN — PRODUCTOS
// ==========================================================

// Crear Producto
app.post("/api/productos", verificarAdmin, async (req, res) => {
  try {
    const {
      name, nombre,
      price, price_cash,
      stock,
      category, subcategory,
      image_url, image_urls,
      description,
      personalizable, destacado,
      descuento_porcentaje,
      colores,
    } = req.body;

    const nombreFinal = (name || nombre || "").trim();
    if (!nombreFinal) {
      return res.status(400).json({ error: "El nombre del producto es requerido" });
    }

    const nuevoId = crypto.randomUUID();

    const rows = await sql`
      INSERT INTO productos (
        id, name, price, price_cash, stock, category, subcategory,
        image_url, image_urls, description, personalizable, destacado,
        descuento_porcentaje, archivado
      ) VALUES (
        ${nuevoId},
        ${nombreFinal},
        ${Number(price) || 0},
        ${Number(price_cash) || 0},
        ${Number(stock) || 0},
        ${category || ''},
        ${subcategory || null},
        ${image_url || ''},
        ${JSON.stringify(Array.isArray(image_urls) ? image_urls : [])},
        ${description || ''},
        ${personalizable === true},
        ${destacado === true},
        ${Number(descuento_porcentaje) || 0},
        false
      )
      RETURNING *
    `;

    const productoCreado = rows[0];

    // Si vinieron colores/variantes con el alta del producto, se insertan también
    if (Array.isArray(colores) && colores.length > 0) {
      for (const c of colores) {
        if (!c?.color) continue;
        await sql`
          INSERT INTO variantes (producto_id, color, stock, image_url)
          VALUES (${productoCreado.id}, ${c.color}, ${Number(c.stock) || 0}, ${c.image_url || null})
        `;
      }
    }

    res.status(201).json(productoCreado);
  } catch (err) {
    console.error("Error al crear producto:", err);
    res.status(500).json({ error: err.message || "Error al crear el producto" });
  }
});

// Actualizar Producto
app.put("/api/productos/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    name, nombre,
    price, price_cash,
    stock,
    category, subcategory,
    image_url, image_urls,
    description,
    personalizable, destacado,
    descuento_porcentaje,
  } = req.body;

  const nombreFinal = (name || nombre || "").trim();

  try {
    let rows;
    if (stock !== undefined) {
      rows = await sql`
        UPDATE productos SET
          name = ${nombreFinal},
          price = ${Number(price) || 0},
          price_cash = ${Number(price_cash) || 0},
          stock = ${Number(stock) || 0},
          category = ${category || ''},
          subcategory = ${subcategory || null},
          image_url = ${image_url || ''},
          image_urls = ${JSON.stringify(Array.isArray(image_urls) ? image_urls : [])},
          description = ${description || ''},
          personalizable = ${personalizable === true},
          destacado = ${destacado === true},
          descuento_porcentaje = ${Number(descuento_porcentaje) || 0}
        WHERE id = ${id}
        RETURNING *
      `;
    } else {
      // Si el producto tiene variantes de color, el stock lo maneja cada variante
      rows = await sql`
        UPDATE productos SET
          name = ${nombreFinal},
          price = ${Number(price) || 0},
          price_cash = ${Number(price_cash) || 0},
          category = ${category || ''},
          subcategory = ${subcategory || null},
          image_url = ${image_url || ''},
          image_urls = ${JSON.stringify(Array.isArray(image_urls) ? image_urls : [])},
          description = ${description || ''},
          personalizable = ${personalizable === true},
          destacado = ${destacado === true},
          descuento_porcentaje = ${Number(descuento_porcentaje) || 0}
        WHERE id = ${id}
        RETURNING *
      `;
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error al actualizar producto:", err);
    res.status(500).json({ error: err.message || "Error al actualizar el producto" });
  }
});

// Archivar / restaurar Producto
app.put("/api/productos/:id/archive", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { archivado } = req.body;

  try {
    const rows = await sql`
      UPDATE productos SET archivado = ${archivado === true} WHERE id = ${id} RETURNING *
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al archivar producto:", err);
    res.status(500).json({ error: err.message || "Error al archivar el producto" });
  }
});

// Eliminar Producto definitivamente
app.delete("/api/productos/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await sql`DELETE FROM variantes WHERE producto_id = ${id}`;
    const rows = await sql`DELETE FROM productos WHERE id = ${id} RETURNING *`;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }
    res.json({ success: true, message: "Producto eliminado correctamente" });
  } catch (err) {
    console.error("Error al eliminar producto:", err);
    res.status(500).json({ error: err.message || "Error al eliminar el producto" });
  }
});

// ==========================================================
// RUTAS ADMIN — VARIANTES DE COLOR
// ==========================================================

app.get("/api/productos/:productoId/variantes", verificarAdmin, async (req, res) => {
  const { productoId } = req.params;
  try {
    const rows = await sql`
      SELECT * FROM variantes WHERE producto_id = ${productoId} ORDER BY created_at ASC
    `;
    res.json(rows);
  } catch (err) {
    console.error("Error al obtener variantes:", err);
    res.status(500).json({ error: "Error al obtener las variantes" });
  }
});

app.post("/api/productos/:productoId/variantes", verificarAdmin, async (req, res) => {
  const { productoId } = req.params;
  const { color, stock, image_url } = req.body;

  if (!color) {
    return res.status(400).json({ error: "El color es requerido" });
  }

  try {
    const rows = await sql`
      INSERT INTO variantes (producto_id, color, stock, image_url)
      VALUES (${productoId}, ${color.trim()}, ${Number(stock) || 0}, ${image_url || null})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error al agregar variante:", err);
    res.status(500).json({ error: err.message || "Error al agregar el color" });
  }
});

app.delete("/api/variantes/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await sql`DELETE FROM variantes WHERE id = ${id} RETURNING *`;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Variante no encontrada" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error al eliminar variante:", err);
    res.status(500).json({ error: "Error al eliminar el color" });
  }
});

app.put("/api/variantes/:id/stock", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { stock } = req.body;
  try {
    const rows = await sql`
      UPDATE variantes SET stock = ${Number(stock) || 0} WHERE id = ${id} RETURNING *
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Variante no encontrada" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al actualizar stock de variante:", err);
    res.status(500).json({ error: "Error al actualizar el stock" });
  }
});

// ==========================================================
// RUTAS ADMIN — CATEGORÍAS Y SUBCATEGORÍAS
// ==========================================================

// Crear Categoría Principal
app.post("/api/categorias", verificarAdmin, async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) {
      return res.status(400).json({ error: "El nombre de la categoría es requerido" });
    }

    const nuevoId = crypto.randomUUID();
    const nombreLimpio = nombre.trim();
    const slug = nombreLimpio.toLowerCase().replace(/\s+/g, '-');

    const rows = await sql`
      INSERT INTO categorias (id, nombre, slug) 
      VALUES (${nuevoId}, ${nombreLimpio}, ${slug}) 
      RETURNING *
    `;
    
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error al crear categoría:", err);
    res.status(500).json({ error: err.message || "Error al crear la categoría" });
  }
});

// Eliminar Categoría Principal (soporta UUID o Nombre/Slug y evita errores de columnas)
app.delete("/api/categorias/:id", verificarAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let catId = null;

    if (id.includes("-") && id.length > 20) {
      catId = id;
    } else {
      const found = await sql`
        SELECT id FROM categorias 
        WHERE LOWER(nombre) = LOWER(${id}) OR LOWER(slug) = LOWER(${id})
        LIMIT 1
      `;
      if (found.length > 0) {
        catId = found[0].id;
      }
    }

    if (!catId) {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }

    try {
      await sql`DELETE FROM subcategorias WHERE categoria_id = ${catId}`;
    } catch (e1) {
      try {
        await sql`DELETE FROM subcategorias WHERE category_id = ${catId}`;
      } catch (e2) {
        // Si no existe ninguna de las dos columnas, continúa con el borrado principal
      }
    }

    const result = await sql`DELETE FROM categorias WHERE id = ${catId} RETURNING *`;

    if (result.length === 0) {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }

    res.json({ success: true, message: "Categoría eliminada correctamente" });
  } catch (err) {
    console.error("Error al eliminar categoría:", err);
    res.status(500).json({ error: err.message || "Error al eliminar la categoría" });
  }
});

// Crear Subcategoría
app.post("/api/subcategorias", verificarAdmin, async (req, res) => {
  const { categoria_nombre, nombre } = req.body;

  if (!categoria_nombre || !nombre) {
    return res.status(400).json({ error: "La categoría y el nombre de la subcategoría son requeridos" });
  }

  try {
    const rows = await sql`
      INSERT INTO subcategorias (categoria_nombre, nombre)
      VALUES (${categoria_nombre.trim()}, ${nombre.trim()})
      RETURNING *
    `;
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error al crear subcategoría:", err);
    res.status(500).json({ error: err.message || "Error al crear la subcategoría" });
  }
});

// Eliminar Subcategoría
app.delete("/api/subcategorias/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await sql`DELETE FROM subcategorias WHERE id = ${id} RETURNING *`;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Subcategoría no encontrada" });
    }
    res.json({ success: true, message: "Subcategoría eliminada correctamente" });
  } catch (err) {
    console.error("Error al eliminar subcategoría:", err);
    res.status(500).json({ error: err.message || "Error al eliminar la subcategoría" });
  }
});

// ==========================================================
// RUTAS ADMIN — CONFIGURACIÓN DEL SITIO
// ==========================================================

app.put("/api/site_settings", verificarAdmin, async (req, res) => {
  try {
    const data = req.body;
    const existing = await sql`SELECT id FROM site_settings LIMIT 1`;

    if (existing.length > 0) {
      await sql`
        UPDATE site_settings 
        SET 
          telefono = ${data.telefono || data.phone || null},
          email = ${data.email || data.correo || null},
          instagram = ${data.instagram || null},
          quienes_somos = ${data.quienes_somos || data.about_us || null},
          transferencia_titular = ${data.bank_holder || data.transferencia_titular || data.titular || null},
          transferencia_cbu = ${data.bank_cbu || data.transferencia_cbu || data.cbu || null},
          transferencia_alias = ${data.bank_alias || data.transferencia_alias || data.alias || null}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO site_settings (
          telefono, email, instagram, quienes_somos, transferencia_titular, transferencia_cbu, transferencia_alias
        ) VALUES (
          ${data.telefono || data.phone || null},
          ${data.email || data.correo || null},
          ${data.instagram || null},
          ${data.quienes_somos || data.about_us || null},
          ${data.bank_holder || data.transferencia_titular || data.titular || null},
          ${data.bank_cbu || data.transferencia_cbu || data.cbu || null},
          ${data.bank_alias || data.transferencia_alias || data.alias || null}
        )
      `;
    }

    res.json({ success: true, message: "Configuración actualizada correctamente" });
  } catch (err) {
    console.error("Error al actualizar site_settings:", err);
    res.status(500).json({ error: err.message || "Error al guardar la configuración" });
  }
});

// ==========================================================
// RUTAS ADMIN — CUPONES
// ==========================================================

app.get("/api/admin/coupons", verificarAdmin, async (req, res) => {
  try {
    const data = await sql`SELECT * FROM coupons ORDER BY id DESC`;
    res.json(data);
  } catch (err) {
    console.error("Error al obtener cupones:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

app.post("/api/admin/coupons", verificarAdmin, async (req, res) => {
  const { code, discount_percentage, max_uses, expires_at } = req.body;

  if (!code || !discount_percentage) {
    return res.status(400).json({ error: "Código y descuento son requeridos" });
  }

  try {
    const rows = await sql`
      INSERT INTO coupons (code, discount_percentage, max_uses, expires_at, is_active)
      VALUES (${code.toUpperCase().trim()}, ${Number(discount_percentage)}, ${max_uses ? Number(max_uses) : null}, ${expires_at || null}, true)
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al crear cupón:", err);
    res.status(500).json({ error: err.message || "No se pudo crear el cupón" });
  }
});

app.patch("/api/admin/coupons/:id/toggle", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  try {
    await sql`UPDATE coupons SET is_active = ${is_active} WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    console.error("Error al cambiar estado del cupón:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

app.delete("/api/admin/coupons/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM coupons WHERE id = ${id}`;
    res.json({ success: true });
  } catch (err) {
    console.error("Error al eliminar cupón:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ==========================================================
// RUTAS ADMIN — FAQs
// ==========================================================

app.post("/api/admin/faqs", verificarAdmin, async (req, res) => {
  const { question, answer } = req.body;
  const pregunta = req.body.pregunta || question;
  const respuesta = req.body.respuesta || answer;

  if (!pregunta || !respuesta) {
    return res.status(400).json({ error: "Pregunta y respuesta son requeridas" });
  }

  try {
    const rows = await sql`
      INSERT INTO faqs (question, answer)
      VALUES (${pregunta}, ${respuesta})
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al crear FAQ:", err);
    res.status(500).json({ error: "No se pudo guardar la pregunta" });
  }
});

app.delete("/api/admin/faqs/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM faqs WHERE id = ${id}`;
    res.json({ success: true, message: "FAQ eliminada correctamente" });
  } catch (err) {
    console.error("Error al eliminar FAQ:", err);
    res.status(500).json({ error: "No se pudo eliminar la pregunta" });
  }
});

// ==========================================================
// RUTAS ADMIN — GRABADOS (Cloudinary + Neon)
// ==========================================================

app.post("/api/admin/grabados", verificarAdmin, upload.single("image"), async (req, res) => {
  try {
    let imagen_url;

    if (req.file) {
      // Caso 1: llegó el archivo binario -> el backend lo sube a Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "bib_grabados", format: "webp" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(req.file.buffer);
      });
      imagen_url = uploadResult.secure_url;
    } else if (req.body.image_url) {
      // Caso 2: el frontend ya subió la imagen a Cloudinary y solo manda la URL
      imagen_url = req.body.image_url;
    } else {
      return res.status(400).json({ error: "No se proporcionó ninguna imagen" });
    }

    const rows = await sql`
      INSERT INTO grabados (image_url)
      VALUES (${imagen_url})
      RETURNING *
    `;

    res.json(rows[0]);
  } catch (err) {
    console.error("Error al subir el grabado a Cloudinary o Neon:", err);
    res.status(500).json({ error: "No se pudo guardar el grabado" });
  }
});

app.delete("/api/admin/grabados/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM grabados WHERE id = ${id}`;
    res.json({ success: true, message: "Grabado eliminado correctamente" });
  } catch (err) {
    console.error("Error al eliminar el grabado:", err);
    res.status(500).json({ error: "No se pudo eliminar el grabado" });
  }
});

// El frontend también llama a DELETE /api/grabados/:id (sin /admin) — se deja como alias
app.delete("/api/grabados/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await sql`DELETE FROM grabados WHERE id = ${id}`;
    res.json({ success: true, message: "Grabado eliminado correctamente" });
  } catch (err) {
    console.error("Error al eliminar el grabado:", err);
    res.status(500).json({ error: "No se pudo eliminar el grabado" });
  }
});

// ==========================================================
// RUTAS ADMIN — IMÁGENES DE PRODUCTO (Cloudinary + Neon)
// ==========================================================

// Subir imagen PRINCIPAL de un producto (devuelve la URL para guardar en productos.image_url)
app.post("/api/admin/productos/upload-imagen", verificarAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó ninguna imagen" });
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "bib_productos", format: "webp" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({
      url: uploadResult.secure_url,
      public_id: uploadResult.public_id,
    });
  } catch (err) {
    console.error("Error al subir imagen principal a Cloudinary:", err);
    res.status(500).json({ error: "No se pudo subir la imagen" });
  }
});

// Subir una o varias imágenes SECUNDARIAS de un producto
app.post(
  "/api/admin/productos/:productoId/imagenes-secundarias",
  verificarAdmin,
  upload.array("images", 10),
  async (req, res) => {
    const { productoId } = req.params;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No se proporcionó ninguna imagen" });
    }

    try {
      const insertadas = [];

      for (const file of req.files) {
        const uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "bib_productos/secundarias", format: "webp" },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(file.buffer);
        });

        const rows = await sql`
          INSERT INTO imagenes_secundarias (producto_id, url, cloudinary_public_id)
          VALUES (${productoId}, ${uploadResult.secure_url}, ${uploadResult.public_id})
          RETURNING *
        `;
        insertadas.push(rows[0]);
      }

      res.status(201).json(insertadas);
    } catch (err) {
      console.error("Error al subir imágenes secundarias:", err);
      res.status(500).json({ error: "No se pudieron subir las imágenes secundarias" });
    }
  }
);

// Eliminar una imagen secundaria (de Cloudinary y de la base)
app.delete("/api/admin/imagenes-secundarias/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const rows = await sql`SELECT * FROM imagenes_secundarias WHERE id = ${id}`;
    const imagen = rows[0];

    if (!imagen) {
      return res.status(404).json({ error: "Imagen no encontrada" });
    }

    if (imagen.cloudinary_public_id) {
      await cloudinary.uploader.destroy(imagen.cloudinary_public_id).catch((err) => {
        console.warn("No se pudo borrar la imagen de Cloudinary (se borra igual de la base):", err.message);
      });
    }

    await sql`DELETE FROM imagenes_secundarias WHERE id = ${id}`;

    res.json({ success: true, message: "Imagen secundaria eliminada correctamente" });
  } catch (err) {
    console.error("Error al eliminar imagen secundaria:", err);
    res.status(500).json({ error: "No se pudo eliminar la imagen" });
  }
});

// ==========================================================
// RUTAS ADMIN — PEDIDOS (ORDERS)
// ==========================================================

app.put("/api/orders/:identificador/status", verificarAdmin, async (req, res) => {
  const { identificador } = req.params;
  const { estado } = req.body;

  if (!estado) {
    return res.status(400).json({ error: "El estado es requerido" });
  }

  try {
    const rows = await sql`
      UPDATE orders SET estado = ${estado} WHERE identificador = ${identificador} RETURNING *
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al actualizar estado del pedido:", err);
    res.status(500).json({ error: err.message || "Error al actualizar el pedido" });
  }
});

// ==========================================================
// RUTAS ADMIN — RESEÑAS
// ==========================================================

app.put("/api/resenas/:id/aprobar", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await sql`
      UPDATE resenas SET aprobado = true WHERE id = ${id} RETURNING *
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Reseña no encontrada" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al aprobar reseña:", err);
    res.status(500).json({ error: err.message || "Error al aprobar la reseña" });
  }
});

app.delete("/api/resenas/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await sql`DELETE FROM resenas WHERE id = ${id} RETURNING *`;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Reseña no encontrada" });
    }
    res.json({ success: true, message: "Reseña eliminada correctamente" });
  } catch (err) {
    console.error("Error al eliminar reseña:", err);
    res.status(500).json({ error: err.message || "Error al eliminar la reseña" });
  }
});

// ==========================================================
// RUTAS ADMIN — CARRITOS ABANDONADOS
// ==========================================================

app.put("/api/carritos_abandonados/:id", verificarAdmin, async (req, res) => {
  const { id } = req.params;
  const { recuperado } = req.body;

  try {
    const rows = await sql`
      UPDATE carritos_abandonados SET recuperado = ${recuperado === true} WHERE id = ${id} RETURNING *
    `;
    if (rows.length === 0) {
      return res.status(404).json({ error: "Carrito no encontrado" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al actualizar carrito:", err);
    res.status(500).json({ error: err.message || "Error al actualizar el carrito" });
  }
});

// ==========================================================
// PAGOS — MERCADO PAGO
// ==========================================================

app.post("/api/payment/create-preference", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos del pedido incompletos o inválidos" });
  }

  try {
    const { verifiedItems, totalProductos } = await calcularItemsConPrecioReal(items, "mercadopago");

    let montoDescuento = 0;
    if (couponCode) {
      const rows = await sql`
        SELECT * FROM coupons 
        WHERE code = ${couponCode.toUpperCase().trim()} AND is_active = true 
        LIMIT 1
      `;
      const couponData = rows[0];

      if (couponData && (!couponData.expires_at || new Date(couponData.expires_at) >= new Date())) {
        montoDescuento = Math.round((totalProductos * couponData.discount_percentage) / 100);
      }
    }

    const total = Math.max(0, totalProductos - montoDescuento + Number(shippingCost || 0));

    const rowsOrder = await sql`
      INSERT INTO orders (
        nombre_del_cliente, dni, telefono, email, direccion, ciudad, provincia,
        codigo_postal, productos, costo_de_envio, descuento, total, estado, metodo_pago
      ) VALUES (
        ${customer.name || ""}, ${customer.dni || ""}, ${customer.phone || ""}, ${customer.email || ""},
        ${customer.address || ""}, ${customer.city || ""}, ${customer.state || ""}, ${customer.postalCode || ""},
        ${JSON.stringify(verifiedItems)}, ${Number(shippingCost || 0)}, ${montoDescuento}, ${total},
        'pendiente', 'mercadopago'
      )
      RETURNING *
    `;
    const orderData = rowsOrder[0];

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    const discountFactor = totalProductos > 0 ? (totalProductos - montoDescuento) / totalProductos : 1;

    const preferenceItems = verifiedItems.map((item) => {
      const adjustedPrice = Math.round(Number(item.price) * discountFactor * 100) / 100;
      return {
        title: String(item.name).substring(0, 256),
        quantity: Number(item.quantity),
        unit_price: Math.max(0.01, adjustedPrice),
        currency_id: "ARS",
      };
    });

    if (Number(shippingCost) > 0) {
      preferenceItems.push({
        title: shippingDescription || "Costo de envío",
        quantity: 1,
        unit_price: Number(shippingCost),
        currency_id: "ARS",
      });
    }

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: preferenceItems,
        payer: {
          name: customer.name,
          email: customer.email,
        },
        external_reference: orderData.identificador.toString(),
        notification_url: `${BACKEND_URL}/api/payment/webhook`,
        back_urls: {
          success: `${SITE_URL}/checkout/exito`,
          failure: `${SITE_URL}/checkout/error`,
          pending: `${SITE_URL}/checkout/pendiente`,
        },
        auto_return: "approved",
        payment_methods: {
          installments: 3,
          default_installments: 3,
        },
      },
    });

    res.json({ init_point: result.init_point });
  } catch (err) {
    console.error("Error en create-preference:", err);
    res.status(500).json({ error: err.message || "No se pudo iniciar el pago" });
  }
});

// Crear Orden por Transferencia
app.post("/api/payment/create-transfer-order", async (req, res) => {
  const { items, shippingCost, customer, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos de la orden inválidos" });
  }

  try {
    const { verifiedItems, totalProductos } = await calcularItemsConPrecioReal(items, "transferencia");

    let montoDescuento = 0;
    if (couponCode) {
      const rows = await sql`
        SELECT * FROM coupons 
        WHERE code = ${couponCode.toUpperCase().trim()} AND is_active = true 
        LIMIT 1
      `;
      const couponData = rows[0];

      if (couponData && (!couponData.expires_at || new Date(couponData.expires_at) >= new Date())) {
        montoDescuento = Math.round((totalProductos * couponData.discount_percentage) / 100);
      }
    }

    const total = Math.max(0, totalProductos - montoDescuento + Number(shippingCost || 0));
    const datosTransferencia = await obtenerDatosTransferencia();

    const rowsOrder = await sql`
      INSERT INTO orders (
        nombre_del_cliente, dni, telefono, email, direccion, ciudad, provincia,
        codigo_postal, productos, costo_de_envio, descuento, total, estado, metodo_pago
      ) VALUES (
        ${customer.name || ""}, ${customer.dni || ""}, ${customer.phone || ""}, ${customer.email || ""},
        ${customer.address || ""}, ${customer.city || ""}, ${customer.state || ""}, ${customer.postalCode || ""},
        ${JSON.stringify(verifiedItems)}, ${Number(shippingCost || 0)}, ${montoDescuento}, ${total},
        'pendiente', 'transferencia'
      )
      RETURNING *
    `;
    const orderData = rowsOrder[0];

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailTransferencia(orderData, datosTransferencia).catch(console.error);

    res.json({
      orderId: orderData.identificador,
      total,
      datosTransferencia,
    });
  } catch (err) {
    console.error("Error creando pedido por transferencia:", err);
    res.status(500).json({ error: err.message || "No se pudo registrar el pedido" });
  }
});

// Webhook de Mercado Pago
app.post("/api/payment/webhook", async (req, res) => {
  const { type, data, action } = req.body;
  const paymentId = data?.id || req.query["data.id"] || req.query.id;

  if ((type === "payment" || action === "payment.created") && paymentId) {
    try {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const paymentInfo = await response.json();

      if (paymentInfo.status === "approved" && paymentInfo.external_reference) {
        await sql`
          UPDATE orders 
          SET estado = 'completado' 
          WHERE identificador = ${paymentInfo.external_reference}
        `;
      }
    } catch (err) {
      console.error("Error Webhook MP:", err);
    }
  }

  res.sendStatus(200);
});

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
  console.error("Error interno:", err);
  res.status(500).json({ error: "Error en el servidor" });
});

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});