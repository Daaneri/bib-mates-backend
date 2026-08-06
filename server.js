import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONFIGURACIÓN DE URLs tomadas de tus Variables de Render ---
// Lee SITE_URL, le agrega https:// si no lo tiene y remueve la barra final
const rawFrontendUrl = process.env.SITE_URL || process.env.FRONTEND_URL || "https://bibmates.com.ar";
const SITE_URL = rawFrontendUrl.startsWith("http")
  ? rawFrontendUrl.replace(/\/$/, "")
  : `https://${rawFrontendUrl.replace(/\/$/, "")}`;

const BACKEND_URL = (process.env.BACKEND_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// --- MIDDLEWARES ---
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://bibmates.com.ar",
  SITE_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURACIÓN CLIENTES ---
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || "" });

const DEFAULT_URL = process.env.SUPABASE_URL || "https://placeholder.supabase.co";
const DEFAULT_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder";

const supabase = createClient(DEFAULT_URL, DEFAULT_KEY);

// --- CONFIGURACIÓN NODEMAILER ---
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// --- FUNCIONES AUXILIARES CON MAPPING A TUS VARIABLES ---
async function obtenerDatosTransferencia() {
  try {
    const { data } = await supabase.from("settings").select("*").single();
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

// --- ENDPOINTS API ---

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Validar Cupón
app.post("/api/coupons/validate", async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "El código es requerido" });
  }

  try {
    const { data: coupon, error } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code.toUpperCase().trim())
      .eq("is_active", true)
      .single();

    if (error || !coupon) {
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

// Crear Preferencia de Pago en Mercado Pago
app.post("/api/payment/create-preference", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos del pedido incompletos o inválidos" });
  }

  try {
    const totalProductos = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);

    let montoDescuento = 0;
    if (couponCode) {
      const { data: couponData } = await supabase
        .from("coupons")
        .select("*")
        .eq("code", couponCode.toUpperCase().trim())
        .eq("is_active", true)
        .single();

      if (couponData && (!couponData.expires_at || new Date(couponData.expires_at) >= new Date())) {
        montoDescuento = Math.round((totalProductos * couponData.discount_percentage) / 100);
      }
    }

    const total = Math.max(0, totalProductos - montoDescuento + Number(shippingCost || 0));

    // Guardar orden en Supabase
    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert({
        nombre_del_cliente: customer.name || "",
        dni: customer.dni || "",
        telefono: customer.phone || "",
        email: customer.email || "",
        direccion: customer.address || "",
        ciudad: customer.city || "",
        provincia: customer.state || "",
        codigo_postal: customer.postalCode || "",
        productos: items,
        costo_de_envio: Number(shippingCost || 0),
        descuento: montoDescuento,
        total: total,
        estado: "pendiente",
        metodo_pago: "mercadopago",
      })
      .select()
      .single();

    if (orderError) {
      console.error("Error al insertar orden en Supabase:", orderError);
      throw new Error(`Supabase error: ${orderError.message}`);
    }

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    // Ajuste proporcional de ítems si hay cupones
    const discountFactor = totalProductos > 0 ? (totalProductos - montoDescuento) / totalProductos : 1;

    const preferenceItems = items.map((item) => {
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

    // URLs absolutas construidas desde la variable SITE_URL de Render
    const successUrl = `${SITE_URL}/checkout/exito`;
    const failureUrl = `${SITE_URL}/checkout/error`;
    const pendingUrl = `${SITE_URL}/checkout/pendiente`;

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
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl,
        },
        auto_return: "approved",
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
    const totalProductos = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);

    let montoDescuento = 0;
    if (couponCode) {
      const { data: couponData } = await supabase
        .from("coupons")
        .select("*")
        .eq("code", couponCode.toUpperCase().trim())
        .eq("is_active", true)
        .single();

      if (couponData && (!couponData.expires_at || new Date(couponData.expires_at) >= new Date())) {
        montoDescuento = Math.round((totalProductos * couponData.discount_percentage) / 100);
      }
    }

    const total = Math.max(0, totalProductos - montoDescuento + Number(shippingCost || 0));
    const datosTransferencia = await obtenerDatosTransferencia();

    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert({
        nombre_del_cliente: customer.name || "",
        dni: customer.dni || "",
        telefono: customer.phone || "",
        email: customer.email || "",
        direccion: customer.address || "",
        ciudad: customer.city || "",
        provincia: customer.state || "",
        codigo_postal: customer.postalCode || "",
        productos: items,
        costo_de_envio: Number(shippingCost || 0),
        descuento: montoDescuento,
        total: total,
        estado: "pendiente",
        metodo_pago: "transferencia",
      })
      .select()
      .single();

    if (orderError) {
      console.error("Error Supabase al insertar pedido por transferencia:", orderError);
      throw new Error(`Supabase error: ${orderError.message}`);
    }

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
        await supabase
          .from("orders")
          .update({ estado: "completado" })
          .eq("identificador", paymentInfo.external_reference);
      }
    } catch (err) {
      console.error("Error Webhook MP:", err);
    }
  }

  res.sendStatus(200);
});

// Manejo de Errores
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