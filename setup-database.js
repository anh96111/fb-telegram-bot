require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function setupDatabase() {
  try {
    console.log('\n' + '='.repeat(50));
    console.log('🔧 BẮT ĐẦU TẠO DATABASE');
    console.log('='.repeat(50) + '\n');
    
    // Bảng khách hàng
    console.log('📋 Tạo bảng customers...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        fb_id VARCHAR(255) NOT NULL,
        page_id VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        avatar TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(fb_id, page_id)
      )
    `);
    console.log('✓ Đã tạo bảng customers\n');
    
    // Bảng nhãn
    console.log('📋 Tạo bảng labels...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS labels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        emoji VARCHAR(10),
        color VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Đã tạo bảng labels\n');
    
    // Bảng liên kết khách-nhãn
    console.log('📋 Tạo bảng customer_labels...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_labels (
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
        added_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (customer_id, label_id)
      )
    `);
    console.log('✓ Đã tạo bảng customer_labels\n');
    
    // Bảng thread (gộp tin nhắn)
    console.log('📋 Tạo bảng conversation_threads...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        page_id VARCHAR(255) NOT NULL,
        thread_message_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Đã tạo bảng conversation_threads\n');
    
    // Bảng mapping hội thoại
    console.log('📋 Tạo bảng conversation_mappings...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_mappings (
        telegram_message_id BIGINT PRIMARY KEY,
        page_id VARCHAR(255) NOT NULL,
        fb_sender_id VARCHAR(255) NOT NULL,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        detected_language VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Đã tạo bảng conversation_mappings\n');
    
    // Bảng tin nhắn chờ xác nhận
    console.log('📋 Tạo bảng pending_messages...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_messages (
        id SERIAL PRIMARY KEY,
        confirm_id VARCHAR(255) UNIQUE NOT NULL,
        page_id VARCHAR(255) NOT NULL,
        fb_sender_id VARCHAR(255) NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Đã tạo bảng pending_messages\n');
    
    // Bảng quick replies
    console.log('📋 Tạo bảng quick_replies...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quick_replies (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        emoji VARCHAR(10),
        text_vi TEXT NOT NULL,
        text_en TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✓ Đã tạo bảng quick_replies\n');
    
    // Tạo các nhãn mẫu
    console.log('🏷️  Tạo nhãn mẫu...');
    const cacNhanMau = [
      { name: 'vip', emoji: '⭐', color: '#FFD700' },
      { name: 'khieu-nai', emoji: '😠', color: '#FF4444' },
      { name: 'don-hang', emoji: '📦', color: '#FF8800' },
      { name: 'tu-van', emoji: '💬', color: '#00AA00' },
      { name: 'gap', emoji: '🚨', color: '#FF0000' },
      { name: 'moi', emoji: '🟢', color: '#00CC00' },
      { name: 'khach-quen', emoji: '💙', color: '#0088FF' }
    ];
    
    for (const nhan of cacNhanMau) {
      await pool.query(
        'INSERT INTO labels (name, emoji, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
        [nhan.name, nhan.emoji, nhan.color]
      );
    }
    console.log('✓ Đã tạo các nhãn mẫu\n');
    
    // Tạo quick replies mẫu
    console.log('⚡ Tạo quick replies mẫu...');
    const quickRepliesMau = [
      { key: 'chao', emoji: '👋', vi: 'Xin chào! Shop có thể giúp gì cho bạn?', en: 'Hello! How can I help you?' },
      { key: 'camOn', emoji: '🙏', vi: 'Cảm ơn bạn đã liên hệ! Chúc bạn một ngày tốt lành!', en: 'Thank you for contacting us! Have a nice day!' },
      { key: 'doiChut', emoji: '⏳', vi: 'Vui lòng đợi một chút, shop đang kiểm tra thông tin cho bạn.', en: 'Please wait a moment, we are checking the information for you.' },
      { key: 'conHang', emoji: '✅', vi: 'Sản phẩm này hiện đang còn hàng ạ!', en: 'This product is currently in stock!' },
      { key: 'hetHang', emoji: '❌', vi: 'Rất tiếc, sản phẩm này hiện đang hết hàng.', en: 'Sorry, this product is currently out of stock.' },
      { key: 'gia', emoji: '💰', vi: 'Để biết giá chính xác, bạn vui lòng cho shop biết sản phẩm cụ thể nhé!', en: 'For exact pricing, please let us know which specific product you are interested in!' },
      { key: 'ship', emoji: '🚚', vi: 'Shop giao hàng toàn quốc. Phí ship từ 15-30k tùy khu vực.', en: 'We ship nationwide. Shipping fee from 15-30k depending on the area.' }
    ];
    
    for (const qr of quickRepliesMau) {
      await pool.query(
        'INSERT INTO quick_replies (key, emoji, text_vi, text_en) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING',
        [qr.key, qr.emoji, qr.vi, qr.en]
      );
    }
    console.log('✓ Đã tạo quick replies mẫu\n');
    
    console.log('='.repeat(50));
    console.log('🎉 HOÀN THÀNH! Database đã sẵn sàng.');
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ LỖI:', error.message);
    console.error(error);
    process.exit(1);
  }
}

setupDatabase();
