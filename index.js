require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const translate = require('translate-google');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Kết nối database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Khởi tạo Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

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

// Hàm dịch sang tiếng Việt
async function dichSangTiengViet(text) {
  if (!text || text.trim() === '') {
    return { banDich: text, ngonNguGoc: 'unknown', daDich: false };
  }
  
  try {
    // Dịch sang tiếng Việt
    const result = await translate(text, { to: 'vi' });
    
    // Detect ngôn ngữ bằng cách dịch sang tiếng Anh và so sánh
    let ngonNguGoc = 'en';
    
    // Nếu bản dịch giống y hệt bản gốc -> đã là tiếng Việt
    if (result.toLowerCase().trim() === text.toLowerCase().trim()) {
      ngonNguGoc = 'vi';
      return {
        banDich: text,
        ngonNguGoc: 'vi',
        daDich: false
      };
    }
    
    // Detect ngôn ngữ đơn giản
    if (/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text)) {
      ngonNguGoc = 'vi';
    } else if (/[\u4e00-\u9fa5]/.test(text)) {
      ngonNguGoc = 'zh';
    } else if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) {
      ngonNguGoc = 'ja';
    } else if (/[\uac00-\ud7af]/.test(text)) {
      ngonNguGoc = 'ko';
    }
    
    return {
      banDich: result,
      ngonNguGoc: ngonNguGoc,
      daDich: true
    };
  } catch (error) {
    console.error('Lỗi dịch sang tiếng Việt:', error.message);
    return { 
      banDich: text, 
      ngonNguGoc: 'unknown', 
      daDich: false 
    };
  }
}

// Hàm dịch sang tiếng Anh
async function dichSangTiengAnh(text) {
  if (!text || text.trim() === '') {
    return text;
  }
  
  try {
    const result = await translate(text, { to: 'en' });
    return result;
  } catch (error) {
    console.error('Lỗi dịch sang tiếng Anh:', error.message);
    return text; // Fallback: Trả về text gốc
  }
}

// Hàm lấy thông tin khách hàng từ Facebook
async function layThongTinKhachTuFB(pageToken, senderId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${senderId}`,
      {
        params: {
          fields: 'first_name,last_name',
          access_token: pageToken
        }
      }
    );
    
    const firstName = response.data.first_name || '';
    const lastName = response.data.last_name || '';
    const name = `${firstName} ${lastName}`.trim() || `Khách ${senderId.slice(-6)}`;
    
    return {
      name: name,
      avatar: null
    };
  } catch (error) {
    console.error('Lỗi lấy thông tin khách:', error.message);
    // Fallback: Dùng ID làm tên
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
    const fbInfo = await layThongTinKhachTuFB(pageToken, senderId);
    
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

// Xử lý tin nhắn từ khách hàng
async function xuLyTinNhanTuKhach(page, senderId, text) {
  try {
    // Lấy thông tin khách
    const khach = await layHoacTaoKhach(page.id, senderId, page.token);
    const cacNhan = await layNhanKhach(khach.id);
    
    // Dịch tin nhắn sang tiếng Việt
    const ketQuaDich = await dichSangTiengViet(text);
    
    // Tạo chuỗi nhãn
    const chuoiNhan = cacNhan.map(n => `<span style="background:${n.color || '#999'};color:#fff;padding:2px 8px;border-radius:3px;margin:0 2px;">${n.emoji || '🏷️'}${n.name}</span>`).join(' ');
    
    // Kiểm tra thread cũ (48h)
    const threadCu = await layThreadCu(khach.id, page.id);
    
    // Format tin nhắn
    let noiDung = `
<b>━━━━━━━━━━━━━━━━━━━━</b>
<b>🏪 ${page.name}</b> ${chuoiNhan}
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
    const cacNut = {
      inline_keyboard: [
        [
          { text: '🏷️ Thêm nhãn', callback_data: `addlabel_${khach.id}` },
          { text: '📋 Lịch sử', callback_data: `history_${khach.id}` }
        ],
        [
          { text: '✅ Đã xử lý', callback_data: `done_${khach.id}` }
        ]
      ]
    };
    
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
    
    console.log(`✓ Đã chuyển tin nhắn từ ${page.name} - ${khach.name} lên Telegram`);
    
  } catch (error) {
    console.error('Lỗi xử lý tin nhắn từ khách:', error);
  }
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
        if (event.message && event.message.text) {
          await xuLyTinNhanTuKhach(page, event.sender.id, event.message.text);
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
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== process.env.TELEGRAM_GROUP_ID) return;
  if (!msg.reply_to_message) return;
  
  try {
    const query = 'SELECT * FROM conversation_mappings WHERE telegram_message_id = $1';
    const result = await pool.query(query, [msg.reply_to_message.message_id]);
    
    if (result.rows.length === 0) {
      await bot.sendMessage(msg.chat.id, '❌ Không tìm thấy thông tin khách hàng', {
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
    
    // Hiển thị bản dịch để xác nhận
    const tinNhanDaDich = await dichSangTiengAnh(msg.text);
    const confirmId = `${Date.now()}_${mapping.fb_sender_id}`;
    
    await pool.query(`
      INSERT INTO pending_messages (confirm_id, page_id, fb_sender_id, original_text, translated_text, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [confirmId, mapping.page_id, mapping.fb_sender_id, msg.text, tinNhanDaDich]);
    
    const xacNhanMessage = `
📝 <b>Xác nhận bản dịch:</b>

🇻🇳 Tin gốc: "${msg.text}"
🇬🇧 Bản dịch: "${tinNhanDaDich}"
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
    
  } catch (error) {
    console.error('Lỗi xử lý reply:', error);
  }
});

// Xử lý callback query
bot.on('callback_query', async (query) => {
  const data = query.data;
  const [action, id] = data.split('_');
  
  if (action === 'send') {
    try {
      const result = await pool.query('SELECT * FROM pending_messages WHERE confirm_id = $1', [id]);
      
      if (result.rows.length === 0) {
        await bot.answerCallbackQuery(query.id, { text: '❌ Tin nhắn đã hết hạn' });
        return;
      }
      
      const pending = result.rows[0];
      const page = pages.find(p => p.id === pending.page_id);
      
      const response = await axios.post(
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: pending.fb_sender_id },
          message: { text: pending.translated_text }
        },
        { params: { access_token: page.token } }
      );
      
      if (response.data.message_id) {
        await pool.query('DELETE FROM pending_messages WHERE confirm_id = $1', [id]);
        await bot.editMessageText(
          `✅ <b>Đã gửi!</b>\n\n🇬🇧 "${pending.translated_text}"`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML'
          }
        );
        await bot.answerCallbackQuery(query.id, { text: '✅ Đã gửi!' });
      }
    } catch (error) {
      console.error('Lỗi gửi tin:', error);
      await bot.answerCallbackQuery(query.id, { text: '❌ Lỗi gửi tin nhắn' });
    }
  } else if (action === 'cancel') {
    await pool.query('DELETE FROM pending_messages WHERE confirm_id = $1', [id]);
    await bot.editMessageText('❌ Đã hủy', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
    await bot.answerCallbackQuery(query.id, { text: 'Đã hủy' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    pages: pages.length
  });
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
  console.log(`📱 Bot Telegram đã sẵn sàng`);
  console.log(`📄 Đang theo dõi ${pages.length} fanpage`);
  console.log(`${'='.repeat(50)}\n`);
});
