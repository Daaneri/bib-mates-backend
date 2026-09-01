import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";
import { neon } from "@neondatabase/serverless";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Conexión a Neon PostgreSQL
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("⚠️ FALTA LA VARIABLE DATABASE_URL EN EL ARCHIVO .ENV");
}
const sql = neon(databaseUrl || "");

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
      cbu: data?.bank_cbu || process.env.CVU || process.env.BANK_CBU || "No especificado",
      alias: data?.bank_alias || process.env.ALIAS || process.env.BANK_ALIAS || "No especificado",
      titular: data?.bank_holder || process.env.TITULAR_CUENTA || process.env.BANK_HOLDER || "No especificado",
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
      SELECT id, nombre AS name, precio AS price, precio_efectivo AS price_cash 
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
// RUTAS GENÉRICAS REST PARA EXPONER LA BASE DE DATOS
// Sirve para responder las peticiones del frontend
// ==========================================================
app.get("/api/:tabla", async (req, res) => {
  const { tabla } = req.params;
  const tablasPermitidas = [
    "productos", 
    "categorias", 
    "subcategorias", 
    "site_settings", 
    "faqs", 
    "coupons",
    "tags"
  ];

  if (!tablasPermitidas.includes(tabla)) {
    return res.status(400).json({ error: "Tabla no permitida" });
  }

  try {
    // 1. site_settings
    if (tabla === "site_settings") {
      const rows = await sql`SELECT * FROM site_settings LIMIT 1`;
      return res.json(rows[0] || { id: 1 });
    }

    // 2. productos
    if (tabla === "productos") {
      const { destacado, categoria_id } = req.query;

      if (destacado === "true") {
        const rows = await sql`SELECT * FROM productos WHERE destacado = true ORDER BY id DESC`;
        return res.json(rows);
      }

      if (categoria_id) {
        const rows = await sql`SELECT * FROM productos WHERE categoria_id = ${categoria_id} ORDER BY id DESC`;
        return res.json(rows);
      }

      const rows = await sql`SELECT * FROM productos ORDER BY id DESC`;
      return res.json(rows);
    }

    // 3. categorias
    if (tabla === "categorias") {
      const rows = await sql`SELECT * FROM categorias ORDER BY nombre ASC`;
      return res.json(rows);
    }

    // 4. subcategorias
    if (tabla === "subcategorias") {
      const { categoria_id } = req.query;
      if (categoria_id) {
        const rows = await sql`SELECT * FROM subcategorias WHERE categoria_id = ${categoria_id} ORDER BY id ASC`;
        return res.json(rows);
      }
      const rows = await sql`SELECT * FROM subcategorias ORDER BY id ASC`;
      return res.json(rows);
    }

    // 5. faqs (Mapea question -> pregunta y answer -> respuesta)
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

    // 6. coupons
    if (tabla === "coupons") {
      const rows = await sql`SELECT * FROM coupons ORDER BY id DESC`;
      return res.json(rows);
    }

    // Fallback genérico para cualquier otra tabla permitida
    const rows = await sql`SELECT * FROM ${sql(tabla)}`;
    return res.json(rows);

  } catch (err) {
    console.error(`Error al obtener ${tabla}:`, err);
    res.status(200).json([]);
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
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

// Middleware de verificación para Rutas Admin
async function verificarAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// RUTAS ADMIN - CUPONES
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

// Crear Preferencia de Pago en Mercado Pago
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