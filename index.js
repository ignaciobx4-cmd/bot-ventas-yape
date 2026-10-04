import express from "express";
import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto_123";

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Prompt del negocio para la atención de ventas
const PROMPT_AGENCIA = `
Eres un asesor de ventas experto de una agencia de desarrollo web.
Tu objetivo es brindar información clara, persuasiva y concisa sobre el diseño, venta y alquiler de landing pages para negocios.
Servicios principales:
- Landing Pages optimizadas para conversión y ventas.
- Planes de desarrollo a medida y alquiler mensual con hosting incluido.
- Proceso rápido de entrega y adaptación al negocio del cliente.

Instrucciones:
- Responde de forma amigable, directa y profesional.
- Mantén las respuestas breves y adaptadas a WhatsApp.
- Si el cliente desea contratar o pagar, indícale que puede enviar su captura de pago de Yape directamente por este chat.
`;

// Endpoint de verificación del Webhook de Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// Endpoint para recibir eventos de WhatsApp
app.post("/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const remitente = message.from;
      await procesarMensaje(message, remitente);
    }
  } catch (error) {
    console.error("Error al procesar el webhook:", error.message);
  }
});

// Función para descargar la imagen enviada por WhatsApp y convertirla a Base64
async function obtenerImagenBase64(mediaId) {
  // 1. Obtener URL de descarga desde Meta Graph API
  const urlRes = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    }
  );

  const mediaUrl = urlRes.data.url;

  // 2. Descargar la imagen como ArrayBuffer
  const imageRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });

  // 3. Convertir a Base64
  return Buffer.from(imageRes.data).toString("base64");
}

// Función principal de procesamiento con Gemini
async function procesarMensaje(message, remitente) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // --- FLUJO 1: MENSAJE CON IMAGEN (Captura de Yape) ---
    if (message.type === "image") {
      await enviarMensajeWhatsApp(
        remitente,
        "Analizando tu comprobante de Yape, dame un momento..."
      );

      const base64Image = await obtenerImagenBase64(message.image.id);

      const promptYape = `
        Analiza esta imagen y determina si es un comprobante de pago válido de Yape.
        Extrae los siguientes datos y responde de forma breve y clara en texto legible para WhatsApp:
        1. Estado (¿Es pago válido/exitoso?): Sí / No
        2. Monto transferido (en S/):
        3. Nombre o destino que recibe el pago:
        4. Fecha y hora del pago:
      `;

      const result = await model.generateContent([
        promptYape,
        {
          inlineData: {
            data: base64Image,
            mimeType: message.image.mime_type || "image/jpeg",
          },
        },
      ]);

      const respuestaIA = result.response.text();
      await enviarMensajeWhatsApp(remitente, respuestaIA);
      return;
    }

    // --- FLUJO 2: MENSAJE DE TEXTO (Ventas / Consultas) ---
    if (message.type === "text") {
      const textoUsuario = message.text.body;

      const chat = model.startChat({
        systemInstruction: PROMPT_AGENCIA,
      });

      // Importante: sendMessage recibe el string directamente para evitar "request is not iterable"
      const result = await chat.sendMessage(textoUsuario);
      const respuestaIA = result.response.text();

      await enviarMensajeWhatsApp(remitente, respuestaIA);
    }
  } catch (error) {
    console.error("Error dentro de procesarMensaje:", error);
    await enviarMensajeWhatsApp(
      remitente,
      "Tuvimos un inconveniente al procesar tu solicitud. Por favor intenta de nuevo."
    );
  }
}

// Función para enviar mensajes vía Meta Cloud API
async function enviarMensajeWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error al enviar mensaje a WhatsApp:",
      error.response?.data || error.message
    );
  }
}

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});