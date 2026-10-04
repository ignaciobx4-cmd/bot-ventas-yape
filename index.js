require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

// Memoria temporal de clientes (Guarda en qué estado está cada número)
const clientes = {};

const MONTO_ADELANTO = 175;
const NUMERO_YAPE = process.env.NUMERO_YAPE || "9XXXXXXXX";

// 1. Lógica para procesar fotos de Yape
async function validarComprobanteYape(bufferImagen) {
  const imagenBase64 = bufferImagen.toString("base64");
  const prompt = `
    Analiza esta captura de pantalla de un pago realizado por YAPE.
    Verifica minuciosamente y responde ÚNICAMENTE en JSON con esta estructura:
    {
      "es_yape_real": true/false,
      "monto": número,
      "monto_correcto": true/false (debe ser igual a ${MONTO_ADELANTO}),
      "fecha": "texto fecha",
      "hora": "texto hora",
      "numero_operacion": "texto",
      "mensaje": "Explicación breve"
    }
  `;

  const result = await model.generateContent([
    prompt,
    { inlineData: { data: imagenBase64, mimeType: "image/jpeg" } }
  ]);

  let textoLimpio = result.response.text().replace(/```json|```/g, "").trim();
  return JSON.parse(textoLimpio);
}

// 2. Motor principal de la conversación según el estado
async function procesarMensaje(numero, textoCliente, imagenBuffer = null) {
  if (!clientes[numero]) {
    clientes[numero] = { 
      estado: "ESTADO_1_NUEVO", 
      datosNegocio: {}, 
      adelantoPagado: false, 
      finalPagado: false 
    };
  }

  let cliente = clientes[numero];

  // SI ENVÍA IMAGEN Y ESTÁ ESPERANDO PAGO
  if (imagenBuffer && (cliente.estado === "PAGO_INICIAL" || cliente.estado === "PAGO_FINAL")) {
    try {
      const validacion = await validarComprobanteYape(imagenBuffer);
      if (validacion.es_yape_real && validacion.monto_correcto) {
        if (cliente.estado === "PAGO_INICIAL") {
          cliente.adelantoPagado = true;
          cliente.estado = "DISENO_ITERATIVO";
          return `¡Pago de S/ ${MONTO_ADELANTO} verificado con éxito! 🎉\n\nComenzaré a preparar el primer diseño borrador de tu página web. En breve te enviaré capturas para que me digas si quieres cambiar colores, textos o secciones.`;
        } else {
          cliente.finalPagado = true;
          cliente.estado = "REVISION_HUMANA";
          // Notificación para ti
          console.log(`\n⚠️ ALERTA DE REVISIÓN: El cliente ${numero} completó el pago. Revisa el proyecto antes de enviar el link final.\n`);
          return `¡Pago final recibido correctamente! Tu página web ya está lista. Estoy haciendo las verificaciones finales para entregarte tu enlace oficial.`;
        }
      } else {
        return `Ocurrió un problema con la verificación: ${validacion.mensaje}. Por favor, envía una captura clara de tu Yape.`;
      }
    } catch (err) {
      return "No pude leer claramente el comprobante. Por favor vuelve a enviar la captura de tu Yape.";
    }
  }

  // SI ES CONVERSACIÓN DE TEXTO
  const promptSistema = `
    Eres el asistente de ventas de una agencia de diseño web.
    Precio total de la página web: S/ 350 soles.
    Adelanto requerido para empezar a diseñar: 50% (S/ 175 soles).
    Número de Yape para pagos: ${NUMERO_YAPE}.

    Estado actual del cliente (${numero}): ${cliente.estado}.

    REGLAS OBLIGATORIAS:
    1. Si el cliente rechaza comprar (ej. "no me interesa", "no gracias"): Sé muy amable, desea mucho éxito en su negocio y despídete en 1 sola frase.
    2. Si muestra interés: Persuádelo amablemente resaltando los beneficios de tener su web (Google, rapidez, adaptada a celulares).
    3. Para iniciar: Pídele los datos de su negocio (nombre, rubro, servicios y logo o colores) y explícale que para empezar el diseño se requiere un Yape inicial de S/ 175 soles.
    4. Si el estado es "PAGO_INICIAL": Indícale que envíe la foto del Yape a este chat para validarlo automáticamente.
    5. Si el estado es "DISENO_ITERATIVO": Escucha lo que quiere cambiar de la web y dile que estás ajustando el borrador. Cuando diga que le gusta todo, pídele el 50% restante (S/ 175 soles) para publicarla en internet.
    6. REGLA DE ORO: JAMÁS entregues ningún enlace final de Firebase al cliente.
  `;

  const chat = model.startChat({
    history: [
      { role: "user", parts: [{ text: promptSistema }] },
      { role: "model", parts: [{ text: "Entendido, actuaré según el estado del cliente y las reglas de venta." }] }
    ]
  });

  const res = await chat.sendMessage(textoCliente);
  
  // Actualizar estado si ya dio sus datos
  if (cliente.estado === "ESTADO_1_NUEVO" && textoCliente.length > 10) {
    cliente.estado = "PAGO_INICIAL";
  }

  return res.response.text();
}

// Ruta Webhook para probar o recibir mensajes
// Ruta GET para la verificación de Meta WhatsApp
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Token de verificación
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto_123";

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});
app.post('/webhook', async (req, res) => {
  const { numero, texto, imagenBase64 } = req.body;
  const buffer = imagenBase64 ? Buffer.from(imagenBase64, 'base64') : null;
  const respuestaBot = await procesarMensaje(numero, texto, buffer);
  res.json({ respuesta: respuestaBot });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor del bot listo y escuchando en el puerto ${PORT}`);
});