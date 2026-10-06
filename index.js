import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/generative-ai';
import express from 'express';

// 1. Servidor Express para mantener vivo el servicio en Render
const app = express();
const port = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Bot de WhatsApp activo 24/7');
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});

// 2. Configuración de Variables
const MI_NUMERO_NOTIFICACION = '51963737843@s.whatsapp.net';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Palabras clave para detectar intención comercial
const PALABRAS_CLAVE_WEB = ['web', 'landing', 'pagina', 'página', 'precio', 'cotizacion', 'cotización', 'portafolio', 'ejemplo', 'diseño', 'desarrollo', 'yape', 'cuanto', 'cuánto'];
const chatsActivosBot = new Set();

// MODELOS RESPALDO PARA OPENROUTER (Si Groq falla)
const MODELOS_OPENROUTER = [
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'meta-llama/llama-3.1-8b-instruct:free',
  'google/gemini-2.0-flash-thinking-exp:free'
];

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
 * Descarga una imagen enviada por WhatsApp en un Buffer seguro
 */
async function descargarImagenBuffer(msg) {
  try {
    const imageMessage = msg.message?.imageMessage;
    if (!imageMessage) return null;

    const stream = await downloadContentFromMessage(imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer.length > 0 ? buffer : null;
  } catch (error) {
    console.error('Error al descargar el buffer de la imagen:', error);
    return null;
  }
}

/**
 * 1ª Opción: Consulta principal usando Groq Cloud
 */
async function consultarGroqCloud(mensajeUsuario) {
  if (!GROQ_API_KEY) {
    console.warn('[GROQ] GROQ_API_KEY no encontrada en las variables de entorno.');
    return null;
  }

  try {
    console.log('[GROQ] Intentando consulta principal con Groq (llama-3.3-70b-versatile)...');
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: PROMPT_VENTAS },
          { role: 'user', content: mensajeUsuario }
        ],
        temperature: 0.5,
        max_tokens: 300
      })
    });

    if (response.ok) {
      const data = await response.json();
      const respuesta = data.choices[0]?.message?.content;
      if (respuesta) {
        console.log('✅ [GROQ] Respuesta obtenida con éxito.');
        return respuesta;
      }
    }

    const errorTexto = await response.text();
    console.warn('[GROQ] Falló la llamada a Groq. Detalle:', errorTexto);
  } catch (err) {
    console.error('[GROQ] Error de red o conexión con Groq:', err);
  }

  return null;
}

/**
 * 2ª Opción (Fallback): Consulta de respaldo con OpenRouter
 */
async function consultarOpenRouterGratuito(mensajeUsuario) {
  for (const modelo of MODELOS_OPENROUTER) {
    try {
      console.log(`[OPENROUTER FALLBACK] Intentando con modelo: ${modelo}`);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://landing-pages.web.app',
          'X-Title': 'Bot WhatsApp Ventas'
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: 'system', content: PROMPT_VENTAS },
            { role: 'user', content: mensajeUsuario }
          ]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const respuesta = data.choices[0]?.message?.content;
        if (respuesta) {
          console.log(`✅ [OPENROUTER] Respuesta obtenida con éxito de: ${modelo}`);
          return respuesta;
        }
      }

      const errorDetalle = await response.text();
      console.warn(`[OPENROUTER] Modelo ${modelo} falló. Detalle:`, errorDetalle);
    } catch (err) {
      console.error(`[OPENROUTER] Error conectando con ${modelo}:`, err);
    }
  }

  console.error('❌ [OPENROUTER] Todos los modelos de respaldo en OpenRouter fallaron.');
  return null;
}

/**
 * Generador principal de respuestas de texto (Groq con Fallback a OpenRouter)
 */
async function obtenerRespuestaVentas(mensajeUsuario) {
  // Intentar primero con Groq Cloud
  let respuesta = await consultarGroqCloud(mensajeUsuario);
  
  // Si Groq falla por cualquier razón, pasamos a OpenRouter automáticamente
  if (!respuesta) {
    console.warn('⚠️ [SISTEMA] Groq falló o no está disponible. Activando fallback a OpenRouter...');
    respuesta = await consultarOpenRouterGratuito(mensajeUsuario);
  }

  return respuesta;
}

/**
 * Notificación a tu WhatsApp personal
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
    console.log('✅ Notificación enviada a tu WhatsApp personal.');
  } catch (error) {
    console.error('Error al enviar la notificación al admin:', error);
  }
}

async function procesarMensaje(sock, msg) {
  try {
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    if (!from || from.endsWith('@g.us') || msg.key.fromMe) return;

    const numeroRemitente = from.replace(/[^0-9]/g, '');
    const timestampMensaje = (msg.messageTimestamp || Date.now() / 1000) * 1000;
    const diezDiasEnMs = 10 * 24 * 60 * 60 * 1000;
    const ahora = Date.now();

    const messageType = Object.keys(msg.message)[0];
    const textoUsuario = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const textoMinuscula = textoUsuario.toLowerCase();

    const tieneContextoWeb = PALABRAS_CLAVE_WEB.some(palabra => textoMinuscula.includes(palabra));

    // Filtro contextual
    if (!chatsActivosBot.has(from)) {
      if (ahora - timestampMensaje > diezDiasEnMs && !tieneContextoWeb) {
        console.log(`[IGNORADO] Chat antiguo (>10 días) sin contexto web: ${numeroRemitente}`);
        return;
      }
      chatsActivosBot.add(from);
    }

    // 1. PROCESAR IMÁGENES (Uso exclusivo de Gemini 1.5 Flash)
    if (messageType === 'imageMessage') {
      console.log(`[YAPE - GEMINI] Procesando imagen de ${from}`);
      await sock.sendMessage(from, { text: '🔍 Verificando comprobante de pago...' });

      const buffer = await descargarImagenBuffer(msg);
      if (!buffer) {
        await sock.sendMessage(from, { text: '⚠️ No se pudo procesar la imagen enviada. Por favor, vuelve a enviarla.' });
        return;
      }

      const base64Image = buffer.toString('base64');
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent([
        PROMPT_YAPE,
        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
      ]);

      const respuestaYape = result.response.text();
      await sock.sendMessage(from, { text: respuestaYape });

      if (respuestaYape.toLowerCase().includes('sí') || respuestaYape.toLowerCase().includes('éxito')) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: numeroRemitente,
          monto: '175 / 350',
          detalleCliente: 'Comprobante de Yape verificado.'
        });
      }
      return;
    }

    // 2. PROCESAR TEXTO (Groq con Fallback a OpenRouter)
    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      if (!textoUsuario) return;

      console.log(`[VENTAS] Mensaje entrante de ${from}: ${textoUsuario}`);

      const respuestaVentas = await obtenerRespuestaVentas(textoUsuario);

      if (respuestaVentas) {
        await sock.sendMessage(from, { text: respuestaVentas });
      }

      if (textoUsuario.length > 25 && (textoUsuario.toLowerCase().includes('negocio') || textoUsuario.toLowerCase().includes('https://') || textoUsuario.toLowerCase().includes('instagram'))) {
        await notificarPedidoAAdmin(sock, {
          nombreCliente: msg.pushName || 'Cliente WhatsApp',
          telefono: numeroRemitente,
          monto: 'Por confirmar',
          detalleCliente: textoUsuario
        });
      }
    }
  } catch (error) {
    console.error('Error capturado en procesarMensaje:', error);
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