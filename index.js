import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';

// 1. Servidor Express para mantener vivo el proceso en Render
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp activo 24/7');
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});

// 2. Tu número de WhatsApp personal donde recibirás la notificación de los pedidos
const MI_NUMERO_NOTIFICACION = '51963737843@s.whatsapp.net';

// 3. Inicializar Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT_VENTAS = `
Eres un asesor de ventas directo, conciso y muy persuasivo para nuestra agencia de desarrollo web.

DATOS DEL SERVICIO Y PAGO:
- Producto: Solo vendemos LANDING PAGES (Páginas de aterrizaje profesionales diseñadas desde cero, nunca con plantillas, optimizadas con botón directo a WhatsApp).
- Precio: S/ 350 (pago único).
- Modalidades de Pago: Pago completo de S/ 350 o adelanto del 50% (S/ 175) para iniciar y el saldo contra entrega.
- Datos de Yape:
  • Número: 963737843
  • Titular: Kattia de la Cruz

PORTAFOLIO DE TRABAJOS REALIZADOS:
Si el cliente pide ver ejemplos, modelos o tu portafolio de trabajos anteriores, envíale estos enlaces según su rubro o todos juntos:
- 🏗️ Arquiduo Studio (Arquitectura): https://arquiduo-studio.web.app
- 🛍️ Click & Go Perú (Skincare / Catálogo): https://clickandgo-pe.netlify.app
- 🔧 Soluciones Rápidas (Servicio Técnico): https://soluciones-linea-blanca.web.app
- 💆 Joyas Spa (Spa / Masajes): https://joyas-spa.web.app
Aclara que cada diseño se hace 100% a la medida desde cero según el negocio del cliente.

REGLAS DE CONVERSACIÓN Y CIERRE:
1. BREVEDAD EXTREMA: Responde en máximo 2 a 3 oraciones cortas y amicales.
2. CIERRE Y DATO DE PAGO: Si el cliente confirma que quiere comprar, dice que sí o pregunta cómo pagar, dale de inmediato las opciones de Yape:
   "¡Excelente! Puedes realizar el Yape del 50% (S/ 175) o el pago total (S/ 350) al 963737843 a nombre de Kattia de la Cruz. Por favor reenvíame el comprobante por aquí para verificarlo."
3. RECOPILACIÓN POST-PAGO: Si el cliente solicita los requisitos post-pago, indícale:
   "Para armar tu Landing Page, por favor envíame en un solo mensaje: 1. Nombre de tu negocio, 2. Breve descripción o lista de tus productos/servicios, y 3. El enlace a tu red social principal (Instagram/Facebook)."
`;

const PROMPT_YAPE = `
Analiza la siguiente imagen y determina si es un comprobante de pago válido de Yape.
Extrae obligatoriamente la siguiente información en formato texto simple:
1. ¿Es un comprobante de Yape válido? (Sí / No)
2. Monto yapeado (S/)
3. Nombre del destinatario (Debe corresponder o ser similar a Kattia de la Cruz)
4. Nombre del emisor (si figura)
5. Fecha y hora
6. Nro. de operación

Si el pago es válido por S/ 175 o S/ 350 a Kattia de la Cruz:
Indícale amablemente al cliente que el pago fue verificado con éxito y pídele que envíe el nombre de su negocio, descripción de sus servicios y sus redes sociales para empezar el proyecto.
Si no es legible o no corresponde, indica amablemente que no se pudo validar la imagen.
`;

/**
 * Envía una notificación en UN SOLO MENSAJE ordenado a tu WhatsApp personal
 */
async function notificarPedidoAAdmin(sock, datos) {
  const mensajeFicha = `
🚨 *NUEVO PEDIDO REGISTRADO* 🚨
==================================
👤 *Cliente:* ${datos.nombreCliente}
📱 *WhatsApp:* https://wa.me/${datos.telefono}

💰 *DETALLES DEL PAGO:*
• *Monto Registrado:* S/ ${datos.monto}
• *Estado:* ${datos.monto >= 350 ? 'PAGO COMPLETO (S/ 350)' : 'ADELANTO 50% (S/ 175)'}

🏢 *DATOS DEL NEGOCIO Y PROYECTO:*
• *Mensaje del Cliente:*
"${datos.detalleCliente}"

==================================
📌 *Acción requerida:* Contactar al cliente para solicitar logo/fotos si no los envió y proceder al maquetado.
`;

  try {
    await sock.sendMessage(MI_NUMERO_NOTIFICACION, { text: mensajeFicha });
    console.log('✅ Notificación de pedido enviada a tu WhatsApp personal.');
  } catch (error) {
    console.error('Error al enviar la notificación al admin:', error);
  }
}

async function procesarMensaje(sock, msg) {
  try {
    const from = msg.key.remoteJid;
    if (!from || from.endsWith('@g.us') || msg.key.fromMe) return;

    const messageType = Object.keys(msg.message)[0];

    // 1. PROCESAR IMÁGENES (Comprobante de Yape)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE] Procesando imagen enviada por ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      const buffer = await sock.downloadMediaMessage(msg);
      const base64Image = buffer.toString('base64');

      let result;
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        result = await model.generateContent([
          PROMPT_YAPE,
          { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
        ]);
      } catch (e) {
        console.warn('[YAPE] Reintentando con modelo secundario por alta demanda...');
        const fallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        result = await fallbackModel.generateContent([
          PROMPT_YAPE,
          { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
        ]);
      }

      const respuestaYape = result.response.text();
      await sock.sendMessage(from, { text: respuestaYape });

      if (respuestaYape.toLowerCase().includes('sí') || respuestaYape.toLowerCase().includes('éxito')) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: from.replace(/[^0-9]/g, ''),
          monto: '175 / 350',
          detalleCliente: 'Comprobante de Yape subido y verificado.'
        });
      }
      return;
    }

    // 2. PROCESAR TEXTO (Ventas y Recopilación)
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      const textoUsuario = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!textoUsuario) return;

      console.log(`[VENTAS] Mensaje de ${from}: ${textoUsuario}`);

      let respuestaVentas;
      try {
        const model = genAI.getGenerativeModel({ 
          model: 'gemini-2.5-flash',
          systemInstruction: PROMPT_VENTAS
        });
        const chat = model.startChat();
        const result = await chat.sendMessage(textoUsuario);
        respuestaVentas = result.response.text();
      } catch (e) {
        console.warn('[VENTAS] Reintentando generación con modelo secundario...');
        const fallbackModel = genAI.getGenerativeModel({ 
          model: 'gemini-2.0-flash',
          systemInstruction: PROMPT_VENTAS
        });
        const chatFallback = fallbackModel.startChat();
        const resultFallback = await chatFallback.sendMessage(textoUsuario);
        respuestaVentas = resultFallback.response.text();
      }

      await sock.sendMessage(from, { text: respuestaVentas });

      if (textoUsuario.length > 30 && (textoUsuario.toLowerCase().includes('negocio') || textoUsuario.toLowerCase().includes('https://') || textoUsuario.toLowerCase().includes('instagram'))) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: from.replace(/[^0-9]/g, ''),
          monto: 'Por confirmar',
          detalleCliente: textoUsuario
        });
      }
    }
  } catch (error) {
    console.error('Error general al procesar mensaje:', error);
    const from = msg.key?.remoteJid;
    if (from) {
      await sock.sendMessage(from, { 
        text: '¡Hola! En este momento estamos atendiendo varias consultas. Por favor déjanos tu duda sobre nuestras Landing Pages y te responderemos en breve.' 
      });
    }
  }
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"]
  });

  sock.ev.on('creds.update', saveCreds);

  let codigoSolicitado = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (!sock.authState.creds.registered && !codigoSolicitado && (qr || connection === 'connecting')) {
      codigoSolicitado = true;
      let numeroTelefono = (process.env.BOT_PHONE_NUMBER || "51963737843").replace(/[^0-9]/g, '');

      console.log(`\n[AUTH] Generando código de vinculación para: ${numeroTelefono}...`);

      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(numeroTelefono);
          console.log(`\n==================================================`);
          console.log(`CÓDIGO DE VINCULACIÓN EN WHATSAPP: ${code}`);
          console.log(`==================================================\n`);
        } catch (err) {
          console.error("Error al generar el código de vinculación:", err);
          codigoSolicitado = false;
        }
      }, 4000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Conexión cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        iniciarBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot de WhatsApp conectado exitosamente.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        await procesarMensaje(sock, msg);
      }
    }
  });
}

iniciarBot();