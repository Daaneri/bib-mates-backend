import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { Resend } from "resend";
import { MercadoPagoConfig, Preference } from "mercadopago";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

// --- 1. MIDDLEWARES DE SEGURIDAD GENERAL ---
app.use(helmet());

// Restringir orígenes permitidos en CORS
const allowedOrigins = [
  process.env.SITE_URL || "https://bibmates.com.ar",
  "https://www.bibmates.com.ar",
  "http://localhost:5173" // Para desarrollo local
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Acceso no permitido por política de CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10kb" })); // Previene cargas masivas de datos en el body

// Límite global de peticiones (Rate Limiting)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 150,
  message: { error: "Demasiadas solicitudes. Por favor reintenta más tarde." },
});
app.use("/api/", globalLimiter);

// --- CONFIGURACIONES ---
const BUSINESS_NAME = process.env.BUSINESS_NAME || "BIB Mates";
const SITE_URL = process.env.SITE_URL || "https://bibmates.com.ar";
const BACKEND_URL = process.env.BACKEND_URL || "https://bib-mates-backend.onrender.com";

// --- CLIENTES ---
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// --- MIDDLEWARE DE AUTENTICACIÓN PARA ADMIN ---
async function requireAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Acceso denegado. Token ausente." });
    }

    const token = authHeader.split(" ")[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Sesión inválida o expirada." });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Error autenticando la petición." });
  }
}

// --- FUNCIONES AUXILIARES ---
async function obtenerDatosTransferencia() {
  const { data, error } = await supabase
    .from("site_settings")
    .select("transferencia_alias, transferencia_cbu, transferencia_titular")
    .eq("id", 1)
    .single();

  if (error || !data) {
    return {
      alias: process.env.ALIAS || "",
      cvu: process.env.CVU || "",
      titular: process.env.TITULAR_CUENTA || "",
    };
  }

  return {
    alias: data.transferencia_alias || process.env.ALIAS || "",
    cvu: data.transferencia_cbu || process.env.CVU || "",
    titular: data.transferencia_titular || process.env.TITULAR_CUENTA || "",
  };
}

async function enviarEmailNotificacion(orderData) {
  const { error } = await resend.emails.send({
    from: `${BUSINESS_NAME} <onboarding@resend.dev>`,
    to: process.env.EMAIL_ADMIN,
    subject: `Nuevo Pedido #${orderData.identificador}`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #C4A278;">¡Nuevo pedido recibido!</h2>
        <p>Se ha registrado un nuevo pedido en tu página.</p>
        <p><b>Método de pago:</b> ${orderData.metodo_pago === "transferencia" ? "Transferencia bancaria" : "Mercado Pago"}</p>

        <h3>Datos del comprador:</h3>
        <ul>
          <li><b>Nombre:</b> ${orderData.nombre_del_cliente}</li>
          <li><b>DNI:</b> ${orderData.dni || "-"}</li>
          <li><b>Teléfono:</b> ${orderData.telefono}</li>
          <li><b>Correo:</b> ${orderData.email || "-"}</li>
          <li><b>Dirección:</b> ${orderData.direccion}, ${orderData.ciudad} (${orderData.provincia})</li>
          <li><b>C.P.:</b> ${orderData.codigo_postal}</li>
        </ul>

        <h3>Detalle de productos:</h3>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #ddd;">
          <thead>
            <tr style="background-color: #f9f9f9;">
              <th style="border: 1px solid #ddd; padding: 8px;">Producto</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Cantidad</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Precio</th>
            </tr>
          </thead>
          <tbody>
            ${orderData.productos.map(p => `
              <tr>
                <td style="border: 1px solid #ddd; padding: 8px;">${p.name}</td>
                <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${p.quantity}</td>
                <td style="border: 1px solid #ddd; padding: 8px;">$${Number(p.price).toLocaleString('es-AR')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        ${orderData.descuento > 0 ? `<p><b>Descuento aplicado:</b> -$${Number(orderData.descuento).toLocaleString('es-AR')}</p>` : ''}
        <p><b>Costo de envío:</b> ${Number(orderData.costo_de_envio) > 0 ? '$' + Number(orderData.costo_de_envio).toLocaleString('es-AR') : 'A coordinar por WhatsApp'}</p>
        <h3 style="color: #C4A278;">Total: $${Number(orderData.total).toLocaleString('es-AR')}</h3>
      </div>
    `,
  });

  if (error) console.error("Error enviando email al admin:", error);
}

async function enviarEmailConfirmacionCliente(orderData) {
  if (!orderData.email) return;

  const { error } = await resend.emails.send({
    from: `${BUSINESS_NAME} <onboarding@resend.dev>`,
    to: orderData.email,
    subject: `Recibimos tu pedido #${orderData.identificador} - ${BUSINESS_NAME}`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #C4A278;">¡Gracias por tu compra, ${orderData.nombre_del_cliente}!</h2>
        <p>Recibimos tu pedido y ya lo estamos procesando. Acá te dejamos el resumen:</p>

        <table style="width: 100%; border-collapse: collapse; border: 1px solid #ddd; margin: 20px 0;">
          <thead>
            <tr style="background-color: #f9f9f9;">
              <th style="border: 1px solid #ddd; padding: 8px;">Producto</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Cantidad</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Precio</th>
            </tr>
          </thead>
          <tbody>
            ${orderData.productos.map(p => `
              <tr>
                <td style="border: 1px solid #ddd; padding: 8px;">${p.name}</td>
                <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${p.quantity}</td>
                <td style="border: 1px solid #ddd; padding: 8px;">$${Number(p.price).toLocaleString('es-AR')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <p><b>Envío:</b> ${Number(orderData.costo_de_envio) > 0 ? '$' + Number(orderData.costo_de_envio).toLocaleString('es-AR') : 'A coordinar por WhatsApp'}</p>
        <p><b>Dirección de entrega:</b> ${orderData.direccion}, ${orderData.ciudad} (${orderData.provincia})</p>
        <h3 style="color: #C4A278;">Total: $${Number(orderData.total).toLocaleString('es-AR')}</h3>

        <p style="margin-top: 24px;">Cualquier duda sobre tu pedido, escribinos por WhatsApp y te ayudamos.</p>
        <p style="color: #999; font-size: 13px;">${BUSINESS_NAME}</p>
      </div>
    `,
  });

  if (error) console.error("Error enviando email al cliente:", error);
}

async function enviarEmailTransferencia(orderData, datosTransferencia) {
  if (!orderData.email) return;

  const { error } = await resend.emails.send({
    from: `${BUSINESS_NAME} <onboarding@resend.dev>`,
    to: orderData.email,
    subject: `Instrucciones de pago - Pedido #${orderData.identificador} - ${BUSINESS_NAME}`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #C4A278;">¡Gracias por tu pedido, ${orderData.nombre_del_cliente}!</h2>
        <p>Para confirmarlo, hacé la transferencia por el total indicado abajo:</p>

        <table style="width: 100%; border-collapse: collapse; border: 1px solid #ddd; margin: 20px 0;">
          <thead>
            <tr style="background-color: #f9f9f9;">
              <th style="border: 1px solid #ddd; padding: 8px;">Producto</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Cantidad</th>
              <th style="border: 1px solid #ddd; padding: 8px;">Precio</th>
            </tr>
          </thead>
          <tbody>
            ${orderData.productos.map(p => `
              <tr>
                <td style="border: 1px solid #ddd; padding: 8px;">${p.name}</td>
                <td style="border: 1px solid #ddd; padding: 8px; text-align: center;">${p.quantity}</td>
                <td style="border: 1px solid #ddd; padding: 8px;">$${Number(p.price).toLocaleString('es-AR')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        ${orderData.descuento > 0 ? `<p><b>Descuento aplicado:</b> -$${Number(orderData.descuento).toLocaleString('es-AR')}</p>` : ''}
        <p><b>Envío:</b> ${Number(orderData.costo_de_envio) > 0 ? '$' + Number(orderData.costo_de_envio).toLocaleString('es-AR') : 'A coordinar por WhatsApp'}</p>

        <div style="background:#f9f9f9; border:1px solid #ddd; padding:16px; border-radius:6px; margin:16px 0;">
          <p><b>CVU:</b> ${datosTransferencia.cvu}</p>
          <p><b>Alias:</b> ${datosTransferencia.alias}</p>
          <p><b>Titular:</b> ${datosTransferencia.titular}</p>
          <h3 style="color:#C4A278; margin-top:12px;">Total a transferir: $${Number(orderData.total).toLocaleString('es-AR')}</h3>
        </div>

        <p>Una vez hecha la transferencia, respondé este correo o escribinos por WhatsApp con el comprobante para confirmar el pedido.</p>
        <p style="color: #999; font-size: 13px;">${BUSINESS_NAME}</p>
      </div>
    `,
  });

  if (error) console.error("Error enviando email de transferencia:", error);
}

// --- RUTAS PÚBLICAS DE ENVÍO ---
app.post("/api/shipping/quote", async (req, res) => {
  const tarifasFijas = [
    {
      carrierDescription: "Correo Argentino",
      serviceDescription: "Envío Estándar",
      deliveryEstimate: "3-5 días",
      totalPrice: 13000
    },
    {
      carrierDescription: "Motomensajería",
      serviceDescription: "Envío Express (En el día)",
      deliveryEstimate: "24hs",
      totalPrice: 0,
      customLabel: "A coordinar por WhatsApp"
    }
  ];

  res.json({ rates: tarifasFijas });
});

app.get("/api/shipping/geocode/:postalCode", async (req, res) => {
  res.json({ locality: "", state: { name: "" } });
});

// --- RUTAS DE CREACIÓN DE PEDIDOS ---
app.post("/api/payment/create-preference", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos del pedido incompletos o inválidos" });
  }

  try {
    const totalProductos = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);
    const total = totalProductos + Number(shippingCost || 0);

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
        total: total,
        estado: "pendiente",
        metodo_pago: "mercadopago",
      })
      .select()
      .single();

    if (orderError) throw new Error("Error en la base de datos");

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    const preferenceItems = items.map((item) => ({
      title: String(item.name).substring(0, 256),
      quantity: Number(item.quantity),
      unit_price: Number(item.price),
      currency_id: "ARS",
    }));

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
    res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
});

app.post("/api/payment/create-transfer-order", async (req, res) => {
  const { items, shippingCost, customer } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0 || !customer) {
    return res.status(400).json({ error: "Datos de la orden inválidos" });
  }

  try {
    // Se toma el precio exacto que proviene del frontend según la lógica de transferencia/contado
    const totalProductos = items.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);
    const total = totalProductos + Number(shippingCost || 0);

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
        descuento: 0,
        total,
        estado: "pendiente",
        metodo_pago: "transferencia",
      })
      .select()
      .single();

    if (orderError) throw new Error("Error registrando en Supabase");

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

// --- RUTA ADMINISTRATIVA PROTEGIDA ---
app.patch("/api/admin/orders/:id/confirm-transfer", requireAdminAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("orders")
      .update({ estado: "pagado" })
      .eq("identificador", id)
      .eq("metodo_pago", "transferencia")
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Pedido no encontrado o no corresponde a transferencia" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error confirmando transferencia:", err);
    res.status(500).json({ error: "No se pudo confirmar el pedido" });
  }
});

// --- WEBHOOK SEGURA DE MERCADO PAGO ---
app.post("/api/payment/webhook", async (req, res) => {
  try {
    const xSignature = req.headers["x-signature"];
    const xRequestId = req.headers["x-request-id"];

    if (process.env.MP_SECRET_KEY && xSignature) {
      const parts = xSignature.split(",");
      let ts, hash;
      parts.forEach(part => {
        const [key, value] = part.split("=");
        if (key && key.trim() === "ts") ts = value.trim();
        if (key && key.trim() === "v1") hash = value.trim();
      });

      const dataID = req.query["data.id"] || req.body?.data?.id;
      const manifest = `id:${dataID};request-id:${xRequestId};ts:${ts};`;
      
      const hmac = crypto.createHmac("sha256", process.env.MP_SECRET_KEY);
      hmac.update(manifest);
      const sha = hmac.digest("hex");

      if (sha !== hash) {
        console.warn("Intento de webhook no autorizado o con firma inválida.");
        return res.sendStatus(200);
      }
    }

    const topic = req.body?.type || req.query.type || req.query.topic;
    const paymentId = req.body?.data?.id || req.query["data.id"] || req.query.id;

    if (topic !== "payment" || !paymentId) {
      return res.sendStatus(200);
    }

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpResponse.ok) {
      console.error("No se pudo consultar el pago en MercadoPago:", await mpResponse.text());
      return res.sendStatus(200);
    }

    const payment = await mpResponse.json();
    const identificador = payment.external_reference;

    if (!identificador) {
      console.error("El pago no contiene external_reference.");
      return res.sendStatus(200);
    }

    const estadoMap = {
      approved: "pagado",
      pending: "pendiente",
      in_process: "pendiente",
      rejected: "fallido",
      cancelled: "fallido",
      refunded: "fallido",
      charged_back: "fallido",
    };
    const nuevoEstado = estadoMap[payment.status] || "pendiente";

    const { error } = await supabase
      .from("orders")
      .update({ estado: nuevoEstado })
      .eq("identificador", identificador);

    if (error) {
      console.error(`Error actualizando el pedido #${identificador}:`, error);
    } else {
      console.log(`✔ Pedido #${identificador} actualizado a: ${nuevoEstado}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando webhook:", err);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Servidor seguro corriendo en puerto ${PORT}`));