import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from "resend";
import { MercadoPagoConfig, Preference } from "mercadopago";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const BUSINESS_NAME = process.env.BUSINESS_NAME || "BIB Mates";
const SITE_URL = process.env.SITE_URL || "https://bibmates.com.ar";
const BACKEND_URL = process.env.BACKEND_URL || "https://bib-mates-backend.onrender.com";
const DESCUENTO_TRANSFERENCIA = 0.10;

// --- Clientes ---
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// --- ENVIO: Tarifas fijas ---
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

// --- ENVIO: Geocode ---
app.get("/api/shipping/geocode/:postalCode", async (req, res) => {
  res.json({ locality: "", state: { name: "" } });
});

// --- Email de notificación al ADMIN ---
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

  if (error) throw new Error(JSON.stringify(error));
}

// --- Email de confirmación al CLIENTE (Mercado Pago) ---
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

// --- Email de instrucciones de transferencia al CLIENTE ---
async function enviarEmailTransferencia(orderData) {
  if (!orderData.email) return;

  const { error } = await resend.emails.send({
    from: `${BUSINESS_NAME} <onboarding@resend.dev>`,
    to: orderData.email,
    subject: `Instrucciones de pago - Pedido #${orderData.identificador} - ${BUSINESS_NAME}`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #C4A278;">¡Gracias por tu pedido, ${orderData.nombre_del_cliente}!</h2>
        <p>Para confirmarlo, hacé la transferencia por el total indicado abajo (ya incluye el 10% de descuento):</p>

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

        <p><b>Descuento por transferencia:</b> -$${Number(orderData.descuento).toLocaleString('es-AR')}</p>
        <p><b>Envío:</b> ${Number(orderData.costo_de_envio) > 0 ? '$' + Number(orderData.costo_de_envio).toLocaleString('es-AR') : 'A coordinar por WhatsApp'}</p>

        <div style="background:#f9f9f9; border:1px solid #ddd; padding:16px; border-radius:6px; margin:16px 0;">
          <p><b>CVU:</b> ${process.env.CVU}</p>
          <p><b>Alias:</b> ${process.env.ALIAS}</p>
          <p><b>Titular:</b> ${process.env.TITULAR_CUENTA}</p>
          <h3 style="color:#C4A278; margin-top:12px;">Total a transferir: $${Number(orderData.total).toLocaleString('es-AR')}</h3>
        </div>

        <p>Una vez hecha la transferencia, respondé este correo o escribinos por WhatsApp con el comprobante para confirmar el pedido.</p>
        <p style="color: #999; font-size: 13px;">${BUSINESS_NAME}</p>
      </div>
    `,
  });

  if (error) console.error("Error enviando email de transferencia:", error);
}

// --- PAGO: crear pedido en Supabase + preferencia de MercadoPago ---
app.post("/api/payment/create-preference", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer } = req.body;

  try {
    const totalProductos = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
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

    if (orderError) throw new Error("Error en Supabase");

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailConfirmacionCliente(orderData).catch(console.error);

    const preferenceItems = items.map((item) => ({
      title: item.name,
      quantity: item.quantity,
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
    res.status(500).json({ error: "No se pudo iniciar el pago" });
  }
});

// --- PAGO: crear pedido por transferencia bancaria (sin pasarela) ---
app.post("/api/payment/create-transfer-order", async (req, res) => {
  const { items, shippingCost, shippingDescription, customer } = req.body;

  try {
    const totalProductos = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const descuento = Math.round(totalProductos * DESCUENTO_TRANSFERENCIA);
    const total = (totalProductos - descuento) + Number(shippingCost || 0);

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
        descuento,
        total,
        estado: "pendiente",
        metodo_pago: "transferencia",
      })
      .select()
      .single();

    if (orderError) throw new Error("Error en Supabase");

    enviarEmailNotificacion(orderData).catch(console.error);
    enviarEmailTransferencia(orderData).catch(console.error);

    res.json({
      orderId: orderData.identificador,
      total,
      datosTransferencia: {
        cvu: process.env.CVU,
        alias: process.env.ALIAS,
        titular: process.env.TITULAR_CUENTA,
      },
    });
  } catch (err) {
    console.error("Error creando pedido por transferencia:", err);
    res.status(500).json({ error: "No se pudo registrar el pedido" });
  }
});

// --- ADMIN: confirmar manualmente que llegó la transferencia ---
app.patch("/api/admin/orders/:id/confirm-transfer", async (req, res) => {
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
      return res.status(404).json({ error: "Pedido no encontrado o no es por transferencia" });
    }

    res.json(data);
  } catch (err) {
    console.error("Error confirmando transferencia:", err);
    res.status(500).json({ error: "No se pudo confirmar el pedido" });
  }
});

// --- WEBHOOK: MercadoPago avisa acá cuando cambia el estado de un pago ---
// Esto es lo que permite que el pedido pase a "pagado" solo, sin que nadie
// tenga que entrar al panel admin a cambiarlo a mano.
app.post("/api/payment/webhook", async (req, res) => {
  try {
    // MercadoPago manda el aviso de dos formas posibles según la config: por body (webhooks nuevos)
    // o por query string (formato IPN viejo). Contemplamos las dos para no perder ninguna notificación.
    const topic = req.body?.type || req.query.type || req.query.topic;
    const paymentId = req.body?.data?.id || req.query["data.id"] || req.query.id;

    if (topic !== "payment" || !paymentId) {
      // No es una notificación de pago (puede ser de otro tipo, ej. "merchant_order") — la ignoramos.
      return res.sendStatus(200);
    }

    // Nunca confiamos ciegamente en lo que llega del webhook: le preguntamos a MercadoPago
    // los datos reales de ese pago antes de tocar la base de datos.
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpResponse.ok) {
      console.error("No se pudo consultar el pago en MercadoPago:", await mpResponse.text());
      return res.sendStatus(200); // Respondemos 200 igual para que MP no reintente en loop infinito
    }

    const payment = await mpResponse.json();
    const identificador = payment.external_reference;

    if (!identificador) {
      console.error("El pago de MercadoPago no trae external_reference, no se puede vincular a un pedido.");
      return res.sendStatus(200);
    }

    // Traducción del estado de MercadoPago a los estados que ya usa tu panel admin
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
      console.error(`Error actualizando el pedido #${identificador} desde el webhook:`, error);
    } else {
      console.log(`✔ Pedido #${identificador} actualizado a estado: ${nuevoEstado}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando webhook de MercadoPago:", err);
    res.sendStatus(200); // Respondemos 200 igual: si devolvemos error, MP reintenta y puede duplicar el procesamiento
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server corriendo en puerto ${PORT}`));