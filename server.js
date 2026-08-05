import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_URL,
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

// Variables de entorno y clientes
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SITE_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || "" });
const DEFAULT_URL = process.env.SUPABASE_URL || "https://placeholder.supabase.co";
const DEFAULT_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder";

const supabase = createClient(DEFAULT_URL, DEFAULT_KEY);

// Configuración Nodemailer
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
    const { data } = await supabase.from("settings").select("*").single();
    return {
      cbu: data?.bank_cbu || process.env.BANK_CBU || "No especificado",
      alias: data?.bank_alias || process.env.BANK_ALIAS || "No especificado",
      titular: data?.bank_holder || process.env.BANK_HOLDER || "No especificado",
      banco: data?.bank_name || process.env.BANK_NAME || "No especificado",
    };
  } catch (err) {
    return {
      cbu: process.env.BANK_CBU || "No especificado",
      alias: process.env.BANK_ALIAS || "No especificado",
      titular: process.env.BANK_HOLDER || "No especificado",
      banco: process.env.BANK_NAME || "No especificado",
    };
  }
}

async function enviarEmailNotificacion(order) {
  if (!process.env.EMAIL_USER) return;

  const productosTexto = order.productos
    .map((p) => `- ${p.name} (x${p.quantity}): $${(p.price * p.quantity).toLocaleString("es-AR")}`)
    .join("\n");

  const mailOptions = {
    from: `"Mi Tienda" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
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
    from: `"Mi Tienda" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Confirmación de Pedido #${order.identificador}`,
    text: `
Hola ${order.nombre_del_cliente},

¡Gracias por tu compra! Tu pedido #${order.identificador} ha sido registrado exitosamente.

Total: $${Number(order.total).toLocaleString("es-AR")}
Método de Pago: Mercado Pago
    `,
  };

  return transporter.sendMail(mailOptions);
}

async function enviarEmailTransferencia(order, datosTransferencia) {
  if (!process.env.EMAIL_USER || !order.email) return;

  const mailOptions = {
    from: `"Mi Tienda" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Datos para Transferencia - Orden #${order.identificador}`,
    text: `
Hola ${order.nombre_del_cliente},

Gracias por tu compra. Realiza la transferencia para completar tu pedido:

Monto Total: $${Number(order.total).toLocaleString("es-AR")}

Datos Bancarios:
- Banco: ${datosTransferencia.banco}
- Titular: ${datosTransferencia.titular}
- CBU: ${datosTransferencia.cbu}
- Alias: ${datosTransferencia.alias}

Responde a este email con el comprobante de pago e indicando el N° de Orden: #${order.identificador}.
    `,
  };

  return transporter.sendMail(mailOptions);
}

// Endpoints API

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

// Mercado Pago Preference
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

    const total = totalProductos - montoDescuento + Number(shippingCost || 0);

    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert({
        nombre_del_cliente: customer.name,
        dni: customer.dni,
        telefono: customer.phone,
        email: customer.email,
        direccion: customer.address,
        ciudad: customer.city,
        provincia: customer.state,
        codigo_postal: customer.postalCode,
        productos: items,
        costo_de_envio: Number(shippingCost || 0),
        descuento: montoDescuento,
        total: total,
        estado: "pendiente",
        metodo_pago: "mercadopago",
      })
      .select()
      .single();

    if (orderError) throw new Error("Error guardando orden en Supabase");

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    const preferenceItems = items.map((item) => ({
      title: String(item.name).substring(0, 256),
      quantity: Number(item.quantity),
      unit_price: Number(item.price),
      currency_id: "ARS",
    }));

    if (montoDescuento > 0) {
      preferenceItems.push({
        title: `Descuento cupón (${couponCode.toUpperCase()})`,
        quantity: 1,
        unit_price: -montoDescuento,
        currency_id: "ARS",
      });
    }

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
        payer: { name: customer.name, email: customer.email },
        external_reference: orderData.identificador.toString(),
        notification_url: `${BACKEND_URL}/api/payment/webhook`,
        back_urls: {
          success: `${SITE_URL}/checkout/exito`,
          failure: `${SITE_URL}/checkout/error`,
          pending: `${SITE_URL}/checkout/pendiente`,
        },
        auto_return: "approved",
        payment_methods: {
          installments: 3 // Fuerza a la preferencia de Mercado Pago a 3 cuotas máximo
        }
      },
    });

    res.json({ init_point: result.init_point });
  } catch (err) {
    console.error("Error en create-preference:", err);
    res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
});

// Orden por Transferencia
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

    const total = totalProductos - montoDescuento + Number(shippingCost || 0);
    const datosTransferencia = await obtenerDatosTransferencia();

    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .insert({
        nombre_del_cliente: customer.name,
        dni: customer.dni,
        telefono: customer.phone,
        email: customer.email,
        direccion: customer.address,
        ciudad: customer.city,
        provincia: customer.state,
        codigo_postal: customer.postalCode,
        productos: items,
        costo_de_envio: Number(shippingCost || 0),
        descuento: montoDescuento,
        total: total,
        estado: "pendiente",
        metodo_pago: "transferencia",
      })
      .select()
      .single();

    if (orderError) throw new Error("Error registrando orden en Supabase");

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailTransferencia(orderData, datosTransferencia).catch(console.error);

    res.json({
      orderId: orderData.identificador,
      total,
      datosTransferencia,
    });
  } catch (err) {
    console.error("Error creando pedido por transferencia:", err);
    res.status(500).json({ error: "No se pudo registrar el pedido" });
  }
});

// Webhook MP
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