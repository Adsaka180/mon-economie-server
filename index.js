require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. SCHEMAS & MODELS (Must be defined first) ---
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    eventCurrency: { type: Number, default: 0 },
    role: { type: String, default: 'USER' },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    reputation: { type: Number, default: 0 },
    title: { type: String, default: "Nouveau" },
    statusMessage: String,
    badges: [String],
    inventory: [String],
    unlockedAchievements: [String],
    friends: [{ userId: String, status: String }],
    streak: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastWheel: { type: Number, default: 0 },
    lastChest: { type: Number, default: 0 },
    isBanned: { type: Boolean, default: false },
    isShadowBanned: { type: Boolean, default: false },
    isMuted: { type: Boolean, default: false },
    isFrozen: { type: Boolean, default: false },
    isInvisible: { type: Boolean, default: false },
    status: { type: String, default: "offline" },
    lastSeen: { type: Number, default: Date.now }
});

UserSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; delete ret.password; return ret; } });
const User = mongoose.model('User', UserSchema);

const ProductSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    stock: Number,
    category: String,
    imageUrl: String,
    sellerId: String,
    sellerName: String,
    createdAt: { type: Number, default: Date.now }
});
ProductSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; return ret; } });
const Product = mongoose.model('Product', ProductSchema);

const AuctionSchema = new mongoose.Schema({
    productId: String,
    productName: String,
    sellerId: String,
    sellerName: String,
    highestBid: Number,
    highestBidderId: String,
    highestBidderName: String,
    endTime: Number,
    isFinished: { type: Boolean, default: false }
});
AuctionSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; return ret; } });
const Auction = mongoose.model('Auction', AuctionSchema);

const LogSchema = new mongoose.Schema({ action: String, details: String, timestamp: { type: Number, default: Date.now } });
LogSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; return ret; } });
const Log = mongoose.model('Log', LogSchema);

const TransactionSchema = new mongoose.Schema({ senderId: String, senderName: String, receiverId: String, receiverName: String, amount: Number, details: String, type: String, timestamp: { type: Number, default: Date.now } });
TransactionSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; return ret; } });
const Transaction = mongoose.model('Transaction', TransactionSchema);

const MessageSchema = new mongoose.Schema({ senderId: String, senderName: String, receiverId: { type: String, default: 'global' }, content: String, timestamp: { type: Number, default: Date.now } });
MessageSchema.set('toJSON', { transform: (doc, ret) => { ret.id = ret._id.toString(); delete ret._id; delete ret.__v; return ret; } });
const Message = mongoose.model('Message', MessageSchema);

const GlobalSettingsSchema = new mongoose.Schema({ appName: { type: String, default: "Économie Virtuelle" }, marketTrend: { type: String, default: "Stable" }, maintenanceMode: { type: Boolean, default: false } });
const GlobalSettings = mongoose.model('GlobalSettings', GlobalSettingsSchema);

// --- 2. INITIALISATION LOGIC ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://adsaka180_db_user:Elbereth2%23@cluster0.0glfahz.mongodb.net/economie?retryWrites=true&w=majority";
let globalSettings = {};

async function initDatabase() {
    try {
        let settings = await GlobalSettings.findOne();
        if (!settings) { settings = new GlobalSettings(); await settings.save(); }
        globalSettings = settings.toObject();

        const adminExists = await User.findOne({ username: "admin" });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash("admin123", 10);
            const admin = new User({ username: "admin", password: hashedPassword, balance: 1000000, role: "SUPER_ADMIN", level: 100, title: "Fondateur" });
            await admin.save();
            const welcomeProd = new Product({ name: "Pack Fondateur", description: "Reset Edition", price: 0, stock: -1, category: "Event", sellerId: admin._id, sellerName: "Admin" });
            await welcomeProd.save();
        }
        console.log("✅ SYSTÈME INITIALISÉ");
    } catch(e) { console.error("❌ Init Error:", e); }
}

mongoose.connect(MONGO_URI).then(() => { console.log("🍃 MongoDB Connected"); initDatabase(); });

// --- 3. SOCKET.IO CORE ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.set('io', io);
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth error"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Auth error"));
        socket.userId = decoded.userId;
        next();
    });
});

io.on('connection', async (socket) => {
    const user = await User.findById(socket.userId);
    if (!user) return;

    user.status = user.isInvisible ? "offline" : "online";
    user.lastSeen = Date.now();
    await user.save();

    socket.join(user._id.toString());
    if (user.role !== 'USER') socket.join('admins');

    if (!user.isInvisible) io.emit('user_status', { userId: user._id, status: "online" });

    // Send Initial Data
    const currentProducts = await Product.find();
    const currentAuctions = await Auction.find({ isFinished: false });
    const leaderboard = await User.find().sort({ balance: -1 }).limit(20);
    const messages = await Message.find({ receiverId: 'global' }).sort({ timestamp: -1 }).limit(50);

    socket.emit('initial_data', {
        currentUser: user, products: currentProducts, settings: globalSettings,
        leaderboard, auctions: currentAuctions, messages: messages.reverse()
    });

    if (user.role !== 'USER') {
        const users = await User.find();
        const logs = await Log.find().sort({ timestamp: -1 }).limit(50);
        socket.emit('admin_data', { users, logs });
    }

    // Handlers
    socket.on('buy_product', async (data) => {
        if (user.isFrozen) return socket.emit('notification', { message: "Compte gelé !" });
        const product = await Product.findById(data.productId);
        if (product && user.balance >= product.price) {
            user.balance -= product.price;
            user.inventory.push(product._id.toString());
            await user.save();
            socket.emit('current_user', user);
            socket.emit('notification', { message: "Achat réussi !" });
        }
    });

    socket.on('admin_modify_user', async (data) => {
        if (user.role === 'USER') return;
        const target = await User.findById(data.userId);
        if (target) {
            Object.assign(target, data.updates);
            await target.save();
            io.to(target._id.toString()).emit('current_user', target);
            io.to('admins').emit('admin_user_updated', target);
        }
    });

    socket.on('disconnect', async () => {
        user.status = "offline";
        await user.save();
        io.emit('user_status', { userId: user._id, status: "offline" });
    });
});

// Self-ping to stay awake
app.get('/ping', (req, res) => res.send('pong'));
setInterval(() => http.get("https://mon-economie-server.onrender.com/ping"), 10 * 60 * 1000);

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 ECO-SYSTEM READY"));
