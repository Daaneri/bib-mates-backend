import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MercadoPagoConfig, Preference } from "mercadopago";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// 1. Middlewares iniciales
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

// 2. Variables de Entorno y Clientes
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;

if (!MP_ACCESS_TOKEN) console.warn("⚠️ ADVERTENCIA: MP_ACCESS_TOKEN no configurado");
if (!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️ ADVERTENCIA: Credenciales de Supabase incompletas");

const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || "" });
const supabase = createClient(SUPABASE_URL || "", SUPABASE_KEY || "");

// 3. Configuración Email Nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Auxiliar: Obtener datos bancarios para transferencia
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

// Auxiliares: Envío de Emails
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
¡Se ha recibido un nuevo pedido!

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

Subtotal Envíos: $${Number(order.costo_de_envio).toLocaleString("es-AR")}
Descuento Aplicado: -$${Number(order.descuento || 0).toLocaleString("es-AR")}
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

Detalle del pago:
Total: $${Number(order.total).toLocaleString("es-AR")}
Método de Pago: Mercado Pago

Te notificaremos por este medio cuando el pedido sea despachado.
    `,
  };

  return transporter.sendMail(mailOptions);
}

async function enviarEmailTransferencia(order, datosTransferencia) {
  if (!process.env.EMAIL_USER || !order.email) return;

  const mailOptions = {
    from: `"Mi Tienda" <${process.env.EMAIL_USER}>`,
    to: order.email,
    subject: `Datos de Transferencia Bancaria - Orden #${order.identificador}`,
    text: `
Hola ${order.nombre_del_cliente},

Gracias por tu compra. Para procesar tu pedido, realiza la transferencia con los datos detallados a continuación:

Monto Total: $${Number(order.total).toLocaleString("es-AR")}

Datos Bancarios:
- Banco: ${datosTransferencia.banco}
- Titular: ${datosTransferencia.titular}
- CBU: ${datosTransferencia.cbu}
- Alias: ${datosTransferencia.alias}

Por favor envía el comprobante respondiendo a este correo con el N° de Orden: #${order.identificador}.
    `,
  };

  return transporter.sendMail(mailOptions);
}

// 4. Endpoints de la API

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Validar Cupón de Descuento
app.post("/api/coupons/validate", async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "El código de cupón es requerido" });
  }

  try {
    const { data: coupon, error } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code.toUpperCase().trim())
      .eq("is_active", true)
      .single();

    if (error || !coupon) {
      return res.status(404).json({ error: "Cupón no válido o expirado" });
    }

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: "El cupón ingresado ha expirado" });
    }

    res.json({
      code: coupon.code,
      discount_percentage: coupon.discount_percentage,
    });
  } catch (err) {
    console.error("Error al validar cupón:", err);
    res.status(500).json({ error: "Error en el servidor al validar cupón" });
  }
});

// Crear Preferencia de Mercado Pago
app.post("/api/payment/create-preference", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos del pedido incompletos o inválidos" });
  }

  try {
    const totalProductos = items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);

    // Re-validar el cupón desde la DB por seguridad
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

    // Insertar la orden en Supabase
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

    if (orderError) {
      console.error("Error BD Supabase:", orderError);
      throw new Error("Error registrando la orden");
    }

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    // Construcción de ítems para Mercado Pago
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
      },
    });

    res.json({ init_point: result.init_point });
  } catch (err) {
    console.error("Error en create-preference:", err);
    res.status(500).json({ error: "No se pudo iniciar el proceso de pago" });
  }
});

// Crear Orden por Transferencia Bancaria
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

    if (orderError) {
      console.error("Error BD Supabase:", orderError);
      throw new Error("Error registrando la orden en BD");
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
    res.status(500).json({ error: "No se pudo registrar el pedido por transferencia" });
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
      console.error("Error procesando Webhook MP:", err);
    }
  }

  res.sendStatus(200);
});

// 5. Manejo global de rutas inexistentes y errores
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

app.use((err, req, res, next) => {
  console.error("Error no controlado:", err.stack);
  res.status(500).json({ error: "Error interno en el servidor" });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose correctamente en el puerto ${PORT}`);
});