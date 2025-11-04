require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
// Khởi động server
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
console.log('🔧 PORT detected:', PORT);
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Translation cache
const translationCache = new Map();
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 giờ

function getCacheKey(text, targetLang) {
  return `${text.toLowerCase().trim()}_${targetLang}`;
}

function getFromCache(text, targetLang) {
  const key = getCacheKey(text, targetLang);
  const cached = translationCache.get(key);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log('✓ Cache hit:', text.substring(0, 30));
    return cached.translation;
  }
  
  return null;
}

function saveToCache(text, targetLang, translation) {
  const key = getCacheKey(text, targetLang);
  
  // Giới hạn cache size
  if (translationCache.size >= CACHE_MAX_SIZE) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  
  translationCache.set(key, {
    translation,
    timestamp: Date.now()
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Cho phép tất cả origin trong dev
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'] // Thêm fallback
});

// Cấu hình upload
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB
  }
});

// Tạo thư mục uploads nếu chưa có
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Lưu danh sách clients đang kết nối
const connectedClients = new Set();

io.on('connection', (socket) => {
  console.log('✓ Web client connected:', socket.id);
  connectedClients.add(socket.id);
  
  socket.on('disconnect', () => {
    console.log('✗ Web client disconnected:', socket.id);
    connectedClients.delete(socket.id);
  });
});

// Hàm gửi tin nhắn mới đến tất cả web clients
function broadcastToWeb(event, data) {
  io.emit(event, data);
  console.log(`📡 Broadcasted ${event} to ${connectedClients.size} clients`);
}

// CORS cho phép web gọi API
const cors = require('cors');
app.use(cors({
  origin: process.env.WEB_URL || '*',
  credentials: true
}));

// Kết nối database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Khởi tạo Telegram bot
const ENABLE_TELEGRAM_POLLING = process.env.NODE_ENV !== 'production';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: ENABLE_TELEGRAM_POLLING
});

if (ENABLE_TELEGRAM_POLLING) {
  console.log('🤖 Telegram bot: Polling mode (local development)');
} else {
  console.log('🤖 Telegram bot: Send-only mode (production)');
}



// Danh sách các fanpage
const pages = [];
for (let i = 1; i <= 10; i++) {
  const pageId = process.env[`PAGE_${i}_ID`];
  const pageName = process.env[`PAGE_${i}_NAME`];
  const pageToken = process.env[`PAGE_${i}_TOKEN`];
  
  if (pageId && pageToken) {
    pages.push({ id: pageId, name: pageName, token: pageToken });
  }
}

console.log(`✓ Đã cấu hình ${pages.length} fanpage`);

// Hàm dịch sang tiếng Việt (Self-hosted LibreTranslate)
async function dichSangTiengViet(text) {
  if (!text || text.trim() === '') {
    return { banDich: text, ngonNguGoc: 'unknown', daDich: false };
  }
  
  try {
    // Detect tiếng Việt
    if (/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text)) {
      return { banDich: text, ngonNguGoc: 'vi', daDich: false };
    }
    
    // Kiểm tra cache trước
    const cached = getFromCache(text, 'vi');
    if (cached) {
      return {
        banDich: cached,
        ngonNguGoc: 'en',
        daDich: true
      };
    }
    
    const translateUrl = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com';
    
    const response = await axios.post(`${translateUrl}/translate`, {
      q: text,
      source: 'auto',
      target: 'vi',
      format: 'text'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    
    if (response.data && response.data.translatedText) {
      const translatedText = response.data.translatedText;
      const detectedLang = response.data.detectedLanguage?.language || 'en';
      
      // Lưu vào cache
      saveToCache(text, 'vi', translatedText);
      
      return {
        banDich: translatedText,
        ngonNguGoc: detectedLang,
        daDich: true
      };
    }
    
    throw new Error('Translation response invalid');
    
  } catch (error) {
    console.error('Lỗi dịch sang tiếng Việt:', error.message);
    return { banDich: text, ngonNguGoc: 'unknown', daDich: false };
  }
}

// Hàm dịch sang tiếng Anh (Self-hosted LibreTranslate)
async function dichSangTiengAnh(text) {
  if (!text || text.trim() === '') return text;
  
  try {
    // Kiểm tra cache
    const cached = getFromCache(text, 'en');
    if (cached) return cached;
    
    const translateUrl = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com';
    
    const response = await axios.post(`${translateUrl}/translate`, {
      q: text,
      source: 'auto',
      target: 'en',
      format: 'text'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    
    if (response.data && response.data.translatedText) {
      const translatedText = response.data.translatedText;
      
      // Lưu vào cache
      saveToCache(text, 'en', translatedText);
      
      return translatedText;
    }
    
    throw new Error('Translation response invalid');
    
  } catch (error) {
    console.error('Lỗi dịch sang tiếng Anh:', error.message);
    return text;
  }
}




// Hàm lấy thông tin khách hàng từ Facebook
async function layThongTinKhachTuFB(pageId, senderId, pageToken) {
  try {
    // Cách 1: Lấy từ conversation (không cần quyền đặc biệt)
    const response = await axios.get(
      `https://graph.facebook.com/v23.0/${pageId}/conversations`,
      {
        params: {
          fields: 'participants',
          user_id: senderId,
          access_token: pageToken
        }
      }
    );
    
    if (response.data && response.data.data && response.data.data.length > 0) {
      const participant = response.data.data[0].participants.data.find(p => p.id === senderId);
      if (participant && participant.name) {
        return {
          name: participant.name,
          avatar: null
        };
      }
    }
    
    // Cách 2: Fallback - Lấy từ PSID
    try {
      const userResponse = await axios.get(
        `https://graph.facebook.com/v23.0/${senderId}`,
        {
          params: {
            fields: 'name',
            access_token: pageToken
          }
        }
      );
      
      if (userResponse.data && userResponse.data.name) {
        return {
          name: userResponse.data.name,
          avatar: null
        };
      }
    } catch (e) {
      console.log('Không thể lấy tên từ PSID');
    }
    
    // Cách 3: Fallback cuối - Dùng ID
    return { 
      name: `Khách #${senderId.slice(-6)}`, 
      avatar: null 
    };
    
  } catch (error) {
    console.error('Lỗi lấy thông tin khách:', error.response?.data || error.message);
    return { 
      name: `Khách #${senderId.slice(-6)}`, 
      avatar: null 
    };
  }
}


// Hàm lấy hoặc tạo khách hàng trong database
async function layHoacTaoKhach(pageId, senderId, pageToken) {
  try {
    const query = 'SELECT * FROM customers WHERE fb_id = $1 AND page_id = $2';
    const result = await pool.query(query, [senderId, pageId]);
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    // Lấy thông tin từ Facebook
    const fbInfo = await layThongTinKhachTuFB(pageId, senderId, pageToken);
    
    // Tạo mới trong database
    const insertQuery = `
      INSERT INTO customers (fb_id, page_id, name, avatar, created_at) 
      VALUES ($1, $2, $3, $4, NOW()) 
      RETURNING *
    `;
    const newCustomer = await pool.query(insertQuery, [senderId, pageId, fbInfo.name, fbInfo.avatar]);
    return newCustomer.rows[0];
  } catch (error) {
    console.error('Lỗi lấy/tạo khách:', error.message);
    return { id: null, fb_id: senderId, name: 'Unknown', avatar: null };
  }
}

// Hàm lấy nhãn của khách hàng
async function layNhanKhach(customerId) {
  try {
    const query = `
      SELECT l.name, l.emoji, l.color
      FROM labels l
      JOIN customer_labels cl ON l.id = cl.label_id
      WHERE cl.customer_id = $1
    `;
    const result = await pool.query(query, [customerId]);
    return result.rows;
  } catch (error) {
    console.error('Lỗi lấy nhãn:', error.message);
    return [];
  }
}

// Hàm lấy thread ID cũ (trong vòng 48h)
async function layThreadCu(customerId, pageId) {
  try {
    const query = `
      SELECT thread_message_id, created_at
      FROM conversation_threads
      WHERE customer_id = $1 AND page_id = $2
      AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await pool.query(query, [customerId, pageId]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Lỗi lấy thread cũ:', error.message);
    return null;
  }
}

// Hàm lưu thread mới
async function luuThreadMoi(customerId, pageId, threadMessageId) {
  try {
    const query = `
      INSERT INTO conversation_threads (customer_id, page_id, thread_message_id, created_at)
      VALUES ($1, $2, $3, NOW())
    `;
    await pool.query(query, [customerId, pageId, threadMessageId]);
  } catch (error) {
    console.error('Lỗi lưu thread:', error.message);
  }
}

// Hàm lưu mapping tin nhắn
async function luuMapping(telegramMsgId, pageId, senderId, customerId, ngonNgu) {
  try {
    const query = `
      INSERT INTO conversation_mappings 
      (telegram_message_id, page_id, fb_sender_id, customer_id, detected_language, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (telegram_message_id) DO UPDATE
      SET page_id = $2, fb_sender_id = $3, customer_id = $4, detected_language = $5
    `;
    await pool.query(query, [telegramMsgId, pageId, senderId, customerId, ngonNgu]);
  } catch (error) {
    console.error('Lỗi lưu mapping:', error.message);
  }
}
// Hàm lưu tin nhắn vào database
async function luuTinNhan(customerId, pageId, senderType, content, mediaType = null, mediaUrl = null, translatedText = null) {
  try {
    await pool.query(`
      INSERT INTO messages (customer_id, page_id, sender_type, content, media_type, media_url, translated_text, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [customerId, pageId, senderType, content, mediaType, mediaUrl, translatedText]);
  } catch (error) {
    console.error('Lỗi lưu tin nhắn:', error.message);
  }
}

// Xử lý tin nhắn từ khách hàng
async function xuLyTinNhanTuKhach(page, senderId, text, media = null) {
  try {
    // Lấy thông tin khách
    const khach = await layHoacTaoKhach(page.id, senderId, page.token);
    const cacNhan = await layNhanKhach(khach.id);
    
    // Dịch tin nhắn sang tiếng Việt
    const ketQuaDich = await dichSangTiengViet(text);
    
    // Tạo chuỗi nhãn
    const chuoiNhan = cacNhan.length > 0 
  ? cacNhan.map(n => `${n.emoji || '🏷️'}<code>${n.name}</code>`).join(' ')
  : '';
    
    // Kiểm tra thread cũ (48h)
    const threadCu = await layThreadCu(khach.id, page.id);
    
    // Format tin nhắn
    let noiDung = `<b>━━━━━━━━━━━━━━━━━━━━</b>
<b>🏪 ${page.name}</b>
${chuoiNhan ? `<b>Nhãn:</b> ${chuoiNhan}\n` : ''}
<b>━━━━━━━━━━━━━━━━━━━━</b>

👤 <b>${khach.name}</b> (#${senderId.slice(-6)})
🌐 <b>Ngôn ngữ:</b> ${ketQuaDich.ngonNguGoc.toUpperCase()}
🕐 <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}
`;

    if (threadCu) {
      const khoangCach = Math.floor((Date.now() - new Date(threadCu.created_at)) / (1000 * 60 * 60));
      noiDung += `🔗 <b>Thread cũ:</b> ${khoangCach}h trước\n`;
    }

    noiDung += `\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n`;
    
    if (ketQuaDich.daDich) {
      noiDung += `💬 <b>Bản dịch (VI):</b>\n<i>${ketQuaDich.banDich}</i>\n\n📝 <b>Tin gốc (${ketQuaDich.ngonNguGoc.toUpperCase()}):</b>\n<code>${text}</code>`;
    } else {
      noiDung += `💬 <b>Tin nhắn:</b>\n<i>${text}</i>`;
    }
    
    noiDung += `\n<b>━━━━━━━━━━━━━━━━━━━━</b>`;
    
    // Tạo các nút
const cacNut = taoNutAction(khach.id, page.id, senderId, ketQuaDich.ngonNguGoc);
    
    // Gửi lên Telegram (reply vào thread cũ nếu có)
    let msg;
    if (threadCu) {
      msg = await bot.sendMessage(process.env.TELEGRAM_GROUP_ID, noiDung, {
        reply_to_message_id: threadCu.thread_message_id,
        reply_markup: cacNut,
        parse_mode: 'HTML'
      });
    } else {
      msg = await bot.sendMessage(process.env.TELEGRAM_GROUP_ID, noiDung, {
        reply_markup: cacNut,
        parse_mode: 'HTML'
      });
      // Lưu thread mới
      await luuThreadMoi(khach.id, page.id, msg.message_id);
    }
    
    // Lưu mapping
    await luuMapping(msg.message_id, page.id, senderId, khach.id, ketQuaDich.ngonNguGoc);
    // Lưu tin nhắn vào database
    await luuTinNhan(khach.id, page.id, 'customer', text, null, null, ketQuaDich.daDich ? ketQuaDich.banDich : null);
    console.log(`✓ Đã chuyển tin nhắn từ ${page.name} - ${khach.name} lên Telegram`);
    // Broadcast đến web
    broadcastToWeb('new_message', {
      customerId: khach.id,
      customerName: khach.name,
      pageId: page.id,
      pageName: page.name,
      message: text,
      translated: ketQuaDich.daDich ? ketQuaDich.banDich : null,
      language: ketQuaDich.ngonNguGoc,
      labels: cacNhan,
      timestamp: new Date().toISOString()
    });
    
    console.log(`✓ Đã chuyển tin nhắn từ ${page.name} - ${khach.name} lên Telegram`);
    
  } catch (error) {
    console.error('Lỗi xử lý tin nhắn từ khách:', error);
  }
}
// Xử lý media từ khách hàng
async function xuLyMediaTuKhach(page, senderId, attachments, caption = '') {
  try {
    // Lấy thông tin khách
    const khach = await layHoacTaoKhach(page.id, senderId, page.token);
    const cacNhan = await layNhanKhach(khach.id);
    
    // Tạo chuỗi nhãn
    const chuoiNhan = cacNhan.length > 0 
      ? cacNhan.map(n => `${n.emoji || '🏷️'}<code>${n.name}</code>`).join(' ')
      : '';
    
    // Kiểm tra thread cũ
    const threadCu = await layThreadCu(khach.id, page.id);
    
    // Header tin nhắn
    let noiDung = `<b>━━━━━━━━━━━━━━━━━━━━</b>
<b>🏪 ${page.name}</b>
${chuoiNhan ? `<b>Nhãn:</b> ${chuoiNhan}\n` : ''}
<b>━━━━━━━━━━━━━━━━━━━━</b>

👤 <b>${khach.name}</b> (#${senderId.slice(-6)})
🕐 <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}
`;

    if (threadCu) {
      const khoangCach = Math.floor((Date.now() - new Date(threadCu.created_at)) / (1000 * 60 * 60));
      noiDung += `🔗 <b>Thread cũ:</b> ${khoangCach}h trước\n`;
    }

    noiDung += `\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n`;
    
    // Xử lý từng attachment
    for (const attachment of attachments) {
      const type = attachment.type;
      const payload = attachment.payload;
      
      if (type === 'image') {
        noiDung += `📷 <b>Ảnh</b>\n`;
        
        const cacNut = taoNutAction(khach.id, page.id, senderId, 'vi');
        
        let msg;
        if (threadCu) {
          msg = await bot.sendPhoto(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_to_message_id: threadCu.thread_message_id,
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
        } else {
          msg = await bot.sendPhoto(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
          await luuThreadMoi(khach.id, page.id, msg.message_id);
        }
        
        await luuMapping(msg.message_id, page.id, senderId, khach.id, 'vi');
        await luuTinNhan(khach.id, page.id, 'customer', caption || '', 'image', payload.url);
        
      } else if (type === 'video') {
        noiDung += `🎥 <b>Video</b>\n`;
        
        const cacNut = taoNutAction(khach.id, page.id, senderId, 'vi');
        
        let msg;
        if (threadCu) {
          msg = await bot.sendVideo(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_to_message_id: threadCu.thread_message_id,
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
        } else {
          msg = await bot.sendVideo(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
          await luuThreadMoi(khach.id, page.id, msg.message_id);
        }
        
        await luuMapping(msg.message_id, page.id, senderId, khach.id, 'vi');
        await luuTinNhan(khach.id, page.id, 'customer', caption || '', 'video', payload.url);
        
      } else if (type === 'file') {
        noiDung += `📎 <b>File</b>\n`;
        
        const cacNut = taoNutAction(khach.id, page.id, senderId, 'vi');
        
        let msg;
        if (threadCu) {
          msg = await bot.sendDocument(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_to_message_id: threadCu.thread_message_id,
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
        } else {
          msg = await bot.sendDocument(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
          await luuThreadMoi(khach.id, page.id, msg.message_id);
        }
        
        await luuMapping(msg.message_id, page.id, senderId, khach.id, 'vi');
        await luuTinNhan(khach.id, page.id, 'customer', caption || '', 'file', payload.url);
        
      } else if (type === 'audio') {
        noiDung += `🎵 <b>Audio</b>\n`;
        
        const cacNut = taoNutAction(khach.id, page.id, senderId, 'vi');
        
        let msg;
        if (threadCu) {
          msg = await bot.sendAudio(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_to_message_id: threadCu.thread_message_id,
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
        } else {
          msg = await bot.sendAudio(process.env.TELEGRAM_GROUP_ID, payload.url, {
            caption: noiDung + (caption ? `\n💬 ${caption}` : ''),
            reply_markup: cacNut,
            parse_mode: 'HTML'
          });
          await luuThreadMoi(khach.id, page.id, msg.message_id);
        }
        
        await luuMapping(msg.message_id, page.id, senderId, khach.id, 'vi');
        await luuTinNhan(khach.id, page.id, 'customer', caption || '', 'audio', payload.url);
        
      } else {
        // Loại khác - gửi dạng text với link
        noiDung += `📌 <b>${type}</b>: <a href="${payload.url}">Xem tại đây</a>\n`;
        await luuTinNhan(khach.id, page.id, 'customer', caption || '', type, payload.url);
      }
    }
    
    console.log(`✓ Đã chuyển ${attachments.length} media từ ${page.name} - ${khach.name} lên Telegram`);
    // Broadcast đến web
    broadcastToWeb('new_message', {
      customerId: khach.id,
      customerName: khach.name,
      pageId: page.id,
      pageName: page.name,
      message: caption || 'Gửi media',
      mediaType: attachments[0]?.type,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Lỗi xử lý media:', error);
  }
}


// Hàm tạo nút action (tách riêng để tái sử dụng)
function taoNutAction(customerId, pageId, senderId, ngonNgu) {
  return {
    inline_keyboard: [
      [
        { text: '⚡ Trả lời nhanh', callback_data: `quickreply_${customerId}_${pageId}_${senderId}_${ngonNgu}` }
      ],
      [
        { text: '🏷️ Thêm nhãn', callback_data: `addlabel_${customerId}` },
        { text: '📋 Lịch sử', callback_data: `history_${customerId}` }
      ],
      [
        { text: '✅ Đã xử lý', callback_data: `done_${customerId}` }
      ]
    ]
  };
}

// Webhook Facebook - Nhận tin nhắn từ khách
app.post('/facebook/webhook', async (req, res) => {
  const body = req.body;
  
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const pageId = entry.id;
      const page = pages.find(p => p.id === pageId);
      
      if (!page) {
        console.log(`Không tìm thấy cấu hình cho page ${pageId}`);
        continue;
      }
      
      for (const event of entry.messaging) {
  if (event.message) {
    // Xử lý text
    if (event.message.text) {
      await xuLyTinNhanTuKhach(page, event.sender.id, event.message.text, null);
    }
    
    // Xử lý attachments (ảnh, video, file...)
    if (event.message.attachments && event.message.attachments.length > 0) {
      await xuLyMediaTuKhach(page, event.sender.id, event.message.attachments, event.message.text);
    }
  }
}

    }
    res.status(200).send('OK');
  } else {
    res.sendStatus(404);
  }
});

// Xác thực webhook Facebook
app.get('/facebook/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    console.log('✓ Webhook đã được xác thực!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Xử lý khi admin reply trong Telegram
if (ENABLE_TELEGRAM_POLLING) {
bot.on('message', async (msg) => {
  // Bỏ qua tin không phải từ group
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  
  // Bỏ qua tin không phải reply
  if (!msg.reply_to_message) return;
  
  // Bỏ qua tin từ bot
  if (msg.from.is_bot) return;

  // Bỏ qua các lệnh bot (bắt đầu bằng /)
  if (msg.text && msg.text.startsWith('/')) return;

  
  try {
    console.log('📩 Nhận reply từ admin:', msg.text);
    
    // Lấy mapping
    const query = 'SELECT * FROM conversation_mappings WHERE telegram_message_id = $1';
    const result = await pool.query(query, [msg.reply_to_message.message_id]);
    
    if (result.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ Không tìm thấy thông tin khách hàng để trả lời', {
        reply_to_message_id: msg.message_id
      });
      return;
    }
    
    const mapping = result.rows[0];
    const page = pages.find(p => p.id === mapping.page_id);
    
    if (!page) {
      await bot.sendMessage(msg.chat.id, '❌ Không tìm thấy cấu hình fanpage', {
        reply_to_message_id: msg.message_id
      });
      return;
    }
    
    console.log('🔄 Đang dịch tin nhắn...');
    
    // Dịch sang tiếng Anh
    const tinNhanDaDich = await dichSangTiengAnh(msg.text);
    
    console.log('✓ Đã dịch:', tinNhanDaDich);
    
    // Tạo ID xác nhận
    const confirmId = `${Date.now()}_${mapping.fb_sender_id}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Lưu vào pending
    await pool.query(`
      INSERT INTO pending_messages (confirm_id, page_id, fb_sender_id, original_text, translated_text, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [confirmId, mapping.page_id, mapping.fb_sender_id, msg.text, tinNhanDaDich]);
    
    console.log('✓ Đã lưu pending message:', confirmId);
    
    // Hiển thị xác nhận
    const xacNhanMessage = `
📝 <b>Xác nhận bản dịch:</b>

🇻🇳 <b>Tin gốc:</b>
<code>${msg.text}</code>

🇬🇧 <b>Bản dịch:</b>
<code>${tinNhanDaDich}</code>

Bạn muốn gửi tin này không?
    `;
    
    await bot.sendMessage(msg.chat.id, xacNhanMessage, {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Gửi luôn', callback_data: `send_${confirmId}` },
            { text: '❌ Hủy', callback_data: `cancel_${confirmId}` }
          ]
        ]
      }
    });
    
    console.log('✓ Đã gửi tin xác nhận');
    
  } catch (error) {
    console.error('❌ Lỗi xử lý reply:', error);
    await bot.sendMessage(msg.chat.id, `❌ Lỗi: ${error.message}`, {
      reply_to_message_id: msg.message_id
    });
  }
});
}
// Xử lý callback query
if (ENABLE_TELEGRAM_POLLING) {
bot.on('callback_query', async (query) => {
  try {
    const data = query.data;
    console.log('🔘 Nhận callback:', data);
    
    const parts = data.split('_');
    const action = parts[0];
    const id = parts.slice(1).join('_'); // Lấy phần còn lại làm ID
    
    if (action === 'send') {
      console.log('📤 Đang gửi tin nhắn...');
      
      // Lấy pending message
      const result = await pool.query('SELECT * FROM pending_messages WHERE confirm_id = $1', [id]);
      
      if (result.rows.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Tin nhắn đã hết hạn' });
        return;
      }
      
      const pending = result.rows[0];
      const page = pages.find(p => p.id === pending.page_id);
      
      if (!page) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy fanpage' });
        return;
      }
      
      console.log('📮 Gửi đến Facebook:', pending.fb_sender_id);
      
      // Gửi về Facebook
      const response = await axios.post(
        `https://graph.facebook.com/v23.0/me/messages`,
        {
          recipient: { id: pending.fb_sender_id },
          message: { text: pending.translated_text },
          messaging_type: 'RESPONSE'
        },
        {
          params: { access_token: page.token }
        }
      );
      
      console.log('✓ Facebook response:', response.data);
      
      if (response.data.message_id) {
        // Xóa pending
        await pool.query('DELETE FROM pending_messages WHERE confirm_id = $1', [id]);
        // Lưu tin nhắn vào database
      const customerResult = await pool.query(
        'SELECT id FROM customers WHERE fb_id = $1 AND page_id = $2',
        [pending.fb_sender_id, pending.page_id]
      );
      if (customerResult.rows.length > 0) {
        await luuTinNhan(customerResult.rows[0].id, pending.page_id, 'admin', pending.translated_text);
      }

        // Cập nhật message
        await bot.editMessageText(
          `✅ <b>Đã gửi thành công!</b>\n\n🇬🇧 <code>${pending.translated_text}</code>`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML'
          }
        );
        
        await bot.answerCallbackQuery(query.id, { text: '✅ Đã gửi!' });
        console.log('✓ Hoàn thành gửi tin');
      }
      
    } else if (action === 'cancel') {
      await pool.query('DELETE FROM pending_messages WHERE confirm_id = $1', [id]);
      await bot.editMessageText('❌ Đã hủy gửi tin nhắn', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
      await bot.answerCallbackQuery(query.id, { text: 'Đã hủy' });
    } else if (action === 'quickreply') {
  // Hiển thị menu quick replies
  const customerId = parts[1];
  const pageId = parts[2];
  const senderId = parts[3];
  const ngonNgu = parts[4] || 'en';
  
  try {
    // Lấy danh sách quick replies
    const qrResult = await pool.query('SELECT * FROM quick_replies ORDER BY key');
    
    if (qrResult.rows.length === 0) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Chưa có câu trả lời nhanh nào' });
      return;
    }
    
    // Tạo keyboard với các quick replies
    const keyboard = [];
    let row = [];
    
    for (let i = 0; i < qrResult.rows.length; i++) {
      const qr = qrResult.rows[i];
      row.push({
        text: `${qr.emoji || '💬'} ${qr.key}`,
        callback_data: `sendqr_${qr.id}_${pageId}_${senderId}_${ngonNgu}`
      });
      
      // 2 nút mỗi hàng
      if (row.length === 2 || i === qrResult.rows.length - 1) {
        keyboard.push(row);
        row = [];
      }
    }
    
    // Thêm nút đóng
    keyboard.push([{ text: '❌ Đóng', callback_data: 'close' }]);
    
    await bot.sendMessage(query.message.chat.id, 
      '⚡ <b>Chọn câu trả lời nhanh:</b>', 
      {
        reply_to_message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
    
    await bot.answerCallbackQuery(query.id);
    
  } catch (error) {
    console.error('Lỗi hiển thị quick replies:', error);
    await bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra' });
  }
  
} else if (action === 'sendqr') {
  // Gửi quick reply
  const qrId = parts[1];
  const pageId = parts[2];
  const senderId = parts[3];
  const ngonNgu = parts[4] || 'en';
  
  try {
    // Lấy quick reply
    const qrResult = await pool.query('SELECT * FROM quick_replies WHERE id = $1', [qrId]);
    
    if (qrResult.rows.length === 0) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy câu trả lời' });
      return;
    }
    
    const qr = qrResult.rows[0];
    const page = pages.find(p => p.id === pageId);
    
    if (!page) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy fanpage' });
      return;
    }
    
    // Chọn ngôn ngữ phù hợp
    const tinNhan = ngonNgu === 'vi' ? qr.text_vi : qr.text_en;
    
    console.log(`📤 Gửi quick reply "${qr.key}" (${ngonNgu}):`, tinNhan);
    
    // Gửi về Facebook
    const response = await axios.post(
      `https://graph.facebook.com/v23.0/me/messages`,
      {
        recipient: { id: senderId },
        message: { text: tinNhan },
        messaging_type: 'RESPONSE'
      },
      {
        params: { access_token: page.token }
      }
    );
    
    if (response.data.message_id) {
      await bot.answerCallbackQuery(query.id, { text: `✅ Đã gửi: ${qr.emoji} ${qr.key}` });
      
      // Thông báo trong chat
      await bot.sendMessage(query.message.chat.id, 
        `✅ Đã gửi quick reply: ${qr.emoji}<code>${qr.key}</code>\n\n💬 "${tinNhan}"`,
        {
          reply_to_message_id: query.message.message_id,
          parse_mode: 'HTML'
        }
      );
      
      console.log('✓ Đã gửi quick reply thành công');
    }
    
  } catch (error) {
    console.error('Lỗi gửi quick reply:', error);
    await bot.answerCallbackQuery(query.id, { text: '❌ Lỗi gửi tin nhắn' });
  }
  
} else if (action === 'close') {
  await bot.deleteMessage(query.message.chat.id, query.message.message_id);
  await bot.answerCallbackQuery(query.id);
  
  
    } else if (action === 'addlabel') {
      await bot.answerCallbackQuery(query.id, { text: 'Reply tin này và gõ: /label <tên-nhãn>' });
      
    } else if (action === 'history') {
  const customerId = id;
  
  try {
    // Hiển thị menu lọc
    const keyboard = [
      [
        { text: '📅 Hôm nay', callback_data: `historyfilter_${customerId}_today` },
        { text: '📅 3 ngày', callback_data: `historyfilter_${customerId}_3days` }
      ],
      [
        { text: '📅 7 ngày', callback_data: `historyfilter_${customerId}_7days` },
        { text: '📅 30 ngày', callback_data: `historyfilter_${customerId}_30days` }
      ],
      [
        { text: '📅 Tất cả', callback_data: `historyfilter_${customerId}_all` }
      ],
      [
        { text: '❌ Đóng', callback_data: 'close' }
      ]
    ];
    
    await bot.sendMessage(query.message.chat.id,
      '📋 <b>Chọn khoảng thời gian:</b>',
      {
        reply_to_message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
    
    await bot.answerCallbackQuery(query.id);
    
  } catch (error) {
    console.error('Lỗi hiển thị menu lịch sử:', error);
    await bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra' });
  }
  
} else if (action === 'historyfilter') {
  const customerId = parts[1];
  const filter = parts[2];
  
  try {
    // Xác định khoảng thời gian
    let timeCondition = '';
    let filterName = '';
    
    switch(filter) {
      case 'today':
        timeCondition = "AND created_at >= CURRENT_DATE";
        filterName = 'Hôm nay';
        break;
      case '3days':
        timeCondition = "AND created_at >= NOW() - INTERVAL '3 days'";
        filterName = '3 ngày qua';
        break;
      case '7days':
        timeCondition = "AND created_at >= NOW() - INTERVAL '7 days'";
        filterName = '7 ngày qua';
        break;
      case '30days':
        timeCondition = "AND created_at >= NOW() - INTERVAL '30 days'";
        filterName = '30 ngày qua';
        break;
      case 'all':
        timeCondition = '';
        filterName = 'Tất cả';
        break;
    }
    
    // Lấy thông tin khách
    const customerInfo = await pool.query('SELECT name FROM customers WHERE id = $1', [customerId]);
    const customerName = customerInfo.rows[0]?.name || 'Unknown';
    
    // Lấy tin nhắn
    const messagesQuery = `
      SELECT sender_type, content, media_type, translated_text, created_at
      FROM messages
      WHERE customer_id = $1 ${timeCondition}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(messagesQuery, [customerId]);
    
    if (result.rows.length === 0) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Không có tin nhắn nào' });
      return;
    }
    
    // Format lịch sử
    let lichSu = `📜 <b>LỊCH SỬ CHAT - ${customerName}</b>\n`;
    lichSu += `🕐 <b>${filterName}</b> (${result.rows.length} tin)\n`;
    lichSu += `${'━'.repeat(30)}\n\n`;
    
    // Đảo ngược để hiển thị từ cũ đến mới
    const messages = result.rows.reverse();
    
    for (const msg of messages) {
      const time = new Date(msg.created_at).toLocaleString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const icon = msg.sender_type === 'customer' ? '👤' : '🤖';
      const sender = msg.sender_type === 'customer' ? 'Khách' : 'Bạn';
      
      lichSu += `${icon} <b>${sender}</b> • ${time}\n`;
      
      if (msg.media_type) {
        lichSu += `📎 ${msg.media_type}\n`;
      }
      
      if (msg.content) {
        const content = msg.content.length > 100 
          ? msg.content.substring(0, 100) + '...' 
          : msg.content;
        lichSu += `💬 ${content}\n`;
      }
      
      if (msg.translated_text && msg.sender_type === 'customer') {
        const trans = msg.translated_text.length > 80
          ? msg.translated_text.substring(0, 80) + '...'
          : msg.translated_text;
        lichSu += `🇻🇳 ${trans}\n`;
      }
      
      lichSu += `\n`;
      
      // Telegram giới hạn 4096 ký tự
      if (lichSu.length > 3800) {
        lichSu += `\n<i>... và ${messages.length - messages.indexOf(msg) - 1} tin nữa</i>`;
        break;
      }
    }
    
    lichSu += `${'━'.repeat(30)}`;
    
    await bot.sendMessage(query.message.chat.id, lichSu, {
      reply_to_message_id: query.message.message_id,
      parse_mode: 'HTML'
    });
    
    await bot.answerCallbackQuery(query.id, { text: '✅ Đã tải lịch sử' });
    
  } catch (error) {
    console.error('Lỗi lấy lịch sử:', error);
    await bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra' });
  }

      
    } else if (action === 'done') {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: '✅ Đã xử lý', callback_data: 'noop' }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.answerCallbackQuery(query.id, { text: 'Đã đánh dấu hoàn thành' });
    }
    
  } catch (error) {
    console.error('❌ Lỗi callback query:', error);
    await bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra' });
  }
});
}
// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    pages: pages.length
  });
});

if (ENABLE_TELEGRAM_POLLING) {
// Lệnh thêm nhãn
bot.onText(/\/label (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  
  if (!msg.reply_to_message) {
    await bot.sendMessage(msg.chat.id, '❌ Vui lòng reply tin nhắn của khách để thêm nhãn', {
      reply_to_message_id: msg.message_id
    });
    return;
  }
  
  const tenNhan = match[1].trim().toLowerCase();
  
  try {
    // Lấy customer_id từ mapping
    const query = 'SELECT customer_id FROM conversation_mappings WHERE telegram_message_id = $1';
    const result = await pool.query(query, [msg.reply_to_message.message_id]);
    
    if (result.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ Không tìm thấy thông tin khách hàng', {
        reply_to_message_id: msg.message_id
      });
      return;
    }
    
    const customerId = result.rows[0].customer_id;
    
    // Tạo hoặc lấy label
    let labelQuery = 'SELECT id, emoji FROM labels WHERE name = $1';
    let labelResult = await pool.query(labelQuery, [tenNhan]);
    
    let labelId, emoji;
    if (labelResult.rows.length === 0) {
      // Tạo label mới với emoji mặc định
      const insertLabel = 'INSERT INTO labels (name, emoji, color) VALUES ($1, $2, $3) RETURNING id, emoji';
      const newLabel = await pool.query(insertLabel, [tenNhan, '🏷️', '#999999']);
      labelId = newLabel.rows[0].id;
      emoji = newLabel.rows[0].emoji;
    } else {
      labelId = labelResult.rows[0].id;
      emoji = labelResult.rows[0].emoji;
    }
    
    // Gán label cho customer
    const assignQuery = `
      INSERT INTO customer_labels (customer_id, label_id, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (customer_id, label_id) DO NOTHING
    `;
    await pool.query(assignQuery, [customerId, labelId]);
    
    await bot.sendMessage(msg.chat.id, `✅ Đã thêm nhãn ${emoji}<code>${tenNhan}</code>`, {
      reply_to_message_id: msg.message_id,
      parse_mode: 'HTML'
    });
    
    console.log(`✓ Đã thêm nhãn "${tenNhan}" cho customer ${customerId}`);
    
  } catch (error) {
    console.error('Lỗi thêm nhãn:', error);
    await bot.sendMessage(msg.chat.id, `❌ Lỗi: ${error.message}`, {
      reply_to_message_id: msg.message_id
    });
  }
});
}
// Lệnh xem danh sách nhãn
bot.onText(/\/labels/, async (msg) => {
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  
  try {
    const result = await pool.query('SELECT name, emoji, color FROM labels ORDER BY name');
    
    if (result.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '📋 Chưa có nhãn nào');
      return;
    }
    
    let danhSach = '<b>📋 DANH SÁCH NHÃN:</b>\n\n';
    
    for (const label of result.rows) {
      danhSach += `${label.emoji || '🏷️'} <code>${label.name}</code>\n`;
    }
    
    danhSach += '\n<i>Dùng: /label tên-nhãn (reply tin khách)</i>';
    
    await bot.sendMessage(msg.chat.id, danhSach, { parse_mode: 'HTML' });
    
  } catch (error) {
    console.error('Lỗi xem nhãn:', error);
    await bot.sendMessage(msg.chat.id, '❌ Lỗi lấy danh sách nhãn');
  }
});
// Lệnh xem quick replies
bot.onText(/\/quickreplies/, async (msg) => {
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  
  try {
    const result = await pool.query('SELECT * FROM quick_replies ORDER BY key');
    
    if (result.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '📋 Chưa có câu trả lời nhanh nào');
      return;
    }
    
    let danhSach = '<b>⚡ DANH SÁCH TRẢ LỜI NHANH:</b>\n\n';
    
    for (const qr of result.rows) {
      danhSach += `${qr.emoji || '💬'} <b>${qr.key}</b>\n`;
      danhSach += `   🇻🇳 ${qr.text_vi}\n`;
      danhSach += `   🇬🇧 ${qr.text_en}\n\n`;
    }
    
    danhSach += '<i>Nhấn nút "⚡ Trả lời nhanh" dưới tin khách để sử dụng</i>';
    
    await bot.sendMessage(msg.chat.id, danhSach, { parse_mode: 'HTML' });
    
  } catch (error) {
    console.error('Lỗi xem quick replies:', error);
    await bot.sendMessage(msg.chat.id, '❌ Lỗi lấy danh sách');
  }
});

// Lệnh thêm quick reply mới
bot.onText(/\/addquick (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  
  // Format: /addquick key|emoji|vi_text|en_text
  const parts = match[1].split('|');
  
  if (parts.length !== 4) {
    await bot.sendMessage(msg.chat.id, 
      '❌ Sai format!\n\n' +
      '<b>Dùng:</b> /addquick key|emoji|text_vi|text_en\n\n' +
      '<b>Ví dụ:</b>\n' +
      '<code>/addquick hello|👋|Xin chào|Hello</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }
  
  const [key, emoji, viText, enText] = parts.map(p => p.trim());
  
  try {
    await pool.query(`
      INSERT INTO quick_replies (key, emoji, text_vi, text_en, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (key) DO UPDATE SET emoji = $2, text_vi = $3, text_en = $4
    `, [key, emoji, viText, enText]);
    
    await bot.sendMessage(msg.chat.id, 
      `✅ Đã thêm quick reply: ${emoji}<code>${key}</code>`,
      { parse_mode: 'HTML' }
    );
    
    console.log(`✓ Đã thêm quick reply "${key}"`);
    
  } catch (error) {
    console.error('Lỗi thêm quick reply:', error);
    await bot.sendMessage(msg.chat.id, `❌ Lỗi: ${error.message}`);
  }
});
// ==================== API ENDPOINTS ====================

// API: Lấy danh sách conversations (OPTIMIZED)
app.get('/api/conversations', async (req, res) => {
  try {
    const { page_id, status, limit = 50 } = req.query;
    
    // Query với LEFT JOIN để lấy labels cùng lúc
    let query = `
      SELECT 
        c.id,
        c.fb_id,
        c.name,
        c.avatar,
        c.page_id,
        c.created_at,
        (
          SELECT json_agg(json_build_object('name', l.name, 'emoji', l.emoji, 'color', l.color))
          FROM labels l
          JOIN customer_labels cl ON l.id = cl.label_id
          WHERE cl.customer_id = c.id
        ) as labels,
        (
          SELECT content
          FROM messages m
          WHERE m.customer_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_message,
        (
          SELECT created_at
          FROM messages m
          WHERE m.customer_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_message_at,
        (
          SELECT sender_type
          FROM messages m
          WHERE m.customer_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_sender
      FROM customers c
      WHERE EXISTS (SELECT 1 FROM messages WHERE customer_id = c.id)
    `;
    
    const params = [];
    
    if (page_id) {
      params.push(page_id);
      query += ` AND c.page_id = $${params.length}`;
    }
    
    query += `
      ORDER BY (
        SELECT created_at
        FROM messages m
        WHERE m.customer_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) DESC NULLS LAST
      LIMIT $${params.length + 1}
    `;
    
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('API Error - conversations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// API: Lấy tin nhắn của 1 conversation
app.get('/api/conversations/:customerId/messages', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { limit = 50 } = req.query;
    
    const result = await pool.query(`
      SELECT 
        id,
        sender_type,
        content,
        media_type,
        media_url,
        translated_text,
        created_at
      FROM messages
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [customerId, limit]);
    
    res.json({
      success: true,
      data: result.rows.reverse() // Đảo ngược để tin cũ lên đầu
    });
    
  } catch (error) {
    console.error('API Error - messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Gửi tin nhắn
app.post('/api/conversations/:customerId/send', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { message, translate } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }
    
    // Lấy thông tin customer
    const customerResult = await pool.query(
      'SELECT fb_id, page_id FROM customers WHERE id = $1',
      [customerId]
    );
    
    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }
    
    const customer = customerResult.rows[0];
    const page = pages.find(p => p.id === customer.page_id);
    
    if (!page) {
      return res.status(404).json({
        success: false,
        error: 'Page not found'
      });
    }
    
    // Dịch nếu cần
    let finalMessage = message;
    if (translate) {
      finalMessage = await dichSangTiengAnh(message);
    }
    
    // Gửi đến Facebook
    const response = await axios.post(
      `https://graph.facebook.com/v23.0/me/messages`,
      {
        recipient: { id: customer.fb_id },
        message: { text: finalMessage },
        messaging_type: 'RESPONSE'
      },
      {
        params: { access_token: page.token }
      }
    );
    
    if (response.data.message_id) {
      // Lưu vào database
      await luuTinNhan(customerId, customer.page_id, 'admin', finalMessage);
      
      // Broadcast đến các clients khác
      broadcastToWeb('message_sent', {
        customerId,
        message: finalMessage,
        originalMessage: message,
        timestamp: new Date().toISOString()
      });
      
      res.json({
        success: true,
        data: {
          messageId: response.data.message_id,
          message: finalMessage
        }
      });
    } else {
      throw new Error('Failed to send message to Facebook');
    }
    
  } catch (error) {
    console.error('API Error - send message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Lấy danh sách labels
app.get('/api/labels', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, emoji, color FROM labels ORDER BY name'
    );
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('API Error - labels:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Thêm label cho customer
app.post('/api/customers/:customerId/labels', async (req, res) => {
  try {
    const { customerId } = req.params;
    const { labelId } = req.body;
    
    await pool.query(`
      INSERT INTO customer_labels (customer_id, label_id, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (customer_id, label_id) DO NOTHING
    `, [customerId, labelId]);
    
    res.json({
      success: true
    });
    
  } catch (error) {
    console.error('API Error - add label:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Lấy quick replies
app.get('/api/quickreplies', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, key, emoji, text_vi, text_en FROM quick_replies ORDER BY key'
    );
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('API Error - quick replies:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    connectedClients: connectedClients.size
  });
});
// API: Dịch text
app.post('/api/translate', async (req, res) => {
  try {
    const { text, to = 'en' } = req.body;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }
    
    let translated;
    if (to === 'en') {
      translated = await dichSangTiengAnh(text);
    } else if (to === 'vi') {
      const result = await dichSangTiengViet(text);
      translated = result.banDich;
    } else {
      throw new Error('Unsupported language');
    }
    
    res.json({
      success: true,
      data: {
        original: text,
        translated: translated,
        language: to
      }
    });
    
  } catch (error) {
    console.error('API Error - translate:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// API: Xóa label khỏi customer
app.delete('/api/customers/:customerId/labels/:labelId', async (req, res) => {
  try {
    const { customerId, labelId } = req.params;
    
    await pool.query(
      'DELETE FROM customer_labels WHERE customer_id = $1 AND label_id = $2',
      [customerId, labelId]
    );
    
    // Broadcast change
    broadcastToWeb('label_removed', { customerId, labelId });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('API Error - remove label:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Tạo label mới
app.post('/api/labels', async (req, res) => {
  try {
    const { name, emoji, color } = req.body;
    
    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Label name is required'
      });
    }
    
    const result = await pool.query(
      'INSERT INTO labels (name, emoji, color, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [name.toLowerCase(), emoji || '🏷️', color || '#999999']
    );
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    if (error.code === '23505') { // Duplicate key
      return res.status(400).json({
        success: false,
        error: 'Label already exists'
      });
    }
    
    console.error('API Error - create label:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Lấy labels của một customer
app.get('/api/customers/:customerId/labels', async (req, res) => {
  try {
    const { customerId } = req.params;
    
    const result = await pool.query(`
      SELECT l.id, l.name, l.emoji, l.color
      FROM labels l
      JOIN customer_labels cl ON l.id = cl.label_id
      WHERE cl.customer_id = $1
      ORDER BY l.name
    `, [customerId]);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('API Error - get customer labels:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// API: Upload file và gửi cho customer
app.post('/api/conversations/:customerId/send-media', upload.single('file'), async (req, res) => {
  try {
    const { customerId } = req.params;
    const { message } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }
    
    console.log('📎 Uploading file:', file.originalname, file.mimetype);
    
    // Lấy thông tin customer
    const customerResult = await pool.query(
      'SELECT fb_id, page_id FROM customers WHERE id = $1',
      [customerId]
    );
    
    if (customerResult.rows.length === 0) {
      // Xóa file tạm
      fs.unlinkSync(file.path);
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }
    
    const customer = customerResult.rows[0];
    const page = pages.find(p => p.id === customer.page_id);
    
    if (!page) {
      fs.unlinkSync(file.path);
      return res.status(404).json({
        success: false,
        error: 'Page not found'
      });
    }
    
    // Xác định loại file
    let attachmentType = 'file';
    if (file.mimetype.startsWith('image/')) {
      attachmentType = 'image';
    } else if (file.mimetype.startsWith('video/')) {
      attachmentType = 'video';
    } else if (file.mimetype.startsWith('audio/')) {
      attachmentType = 'audio';
    }
    
    // Upload file lên Facebook
    const formData = new FormData();
    formData.append('recipient', JSON.stringify({ id: customer.fb_id }));
    formData.append('message', JSON.stringify({
      attachment: {
        type: attachmentType,
        payload: {
          is_reusable: true
        }
      }
    }));
    formData.append('filedata', fs.createReadStream(file.path), {
      filename: file.originalname,
      contentType: file.mimetype
    });
    
    const response = await axios.post(
      'https://graph.facebook.com/v23.0/me/messages',
      formData,
      {
        params: { access_token: page.token },
        headers: formData.getHeaders()
      }
    );
    
    // Xóa file tạm
    fs.unlinkSync(file.path);
    
    if (response.data.message_id) {
      // Lưu vào database
      await luuTinNhan(customerId, customer.page_id, 'admin', message || '', attachmentType, file.originalname);
      
      // Broadcast
      broadcastToWeb('message_sent', {
        customerId,
        message: message || '',
        mediaType: attachmentType,
        mediaName: file.originalname,
        timestamp: new Date().toISOString()
      });
      
      res.json({
        success: true,
        data: {
          messageId: response.data.message_id,
          attachmentId: response.data.attachment_id
        }
      });
    } else {
      throw new Error('Failed to send media to Facebook');
    }
    
  } catch (error) {
    console.error('API Error - send media:', error);
    
    // Xóa file nếu có lỗi
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ==================== QUICK REPLIES MANAGEMENT APIs ====================

// API: Cập nhật quick reply
app.put('/api/quickreplies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { key, emoji, text_vi, text_en } = req.body;
    
    if (!key || !text_vi || !text_en) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }
    
    const result = await pool.query(`
      UPDATE quick_replies 
      SET key = $1, emoji = $2, text_vi = $3, text_en = $4
      WHERE id = $5
      RETURNING *
    `, [key, emoji || '💬', text_vi, text_en, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quick reply not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('API Error - update quick reply:', error);
    
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'Key already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Xóa quick reply
app.delete('/api/quickreplies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM quick_replies WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Quick reply not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('API Error - delete quick reply:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API: Tạo quick reply mới
app.post('/api/quickreplies', async (req, res) => {
  try {
    const { key, emoji, text_vi, text_en } = req.body;
    
    if (!key || !text_vi || !text_en) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }
    
    const result = await pool.query(`
      INSERT INTO quick_replies (key, emoji, text_vi, text_en, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `, [key, emoji || '💬', text_vi, text_en]);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('API Error - create quick reply:', error);
    
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'Key already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delay server start để đảm bảo mọi thứ đã ready
setTimeout(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
    console.log(`🌐 Listening on: http://0.0.0.0:${PORT}`);
    console.log(`📱 Bot Telegram: Send-only mode`);
    console.log(`📄 Đang theo dõi ${pages.length} fanpage`);
    console.log(`✅ Ready to receive requests`);
    console.log(`${'='.repeat(50)}\n`);
  });
}, 100);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, shutting down...');
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received, shutting down...');
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});