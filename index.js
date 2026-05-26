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

// --- DATABASE SETUP ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://adsaka180_db_user:Elbereth2%23@cluster0.0glfahz.mongodb.net/economie?retryWrites=true&w=majority";

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 1000 },
    eventCurrency: { type: Number, default: 0 }, // Nouvelle monnaie événementielle
    role: { type: String, default: 'USER' }, // USER, MODERATOR, ADMIN, SUPER_ADMIN
    permissions: [String], // "can_ban", "can_edit_market", etc.
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    reputation: { type: Number, default: 0 },
    title: String,
    statusMessage: String,
    badges: [String],
    inventory: [String],
    unlockedAchievements: [String],
    friends: [{ userId: String, status: String }],
    streak: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastWheel: { type: Number, default: 0 },
    lastChest: { type: Number, default: 0 },
    totalAccountValue: { type: Number, default: 1000 },
    isBanned: { type: Boolean, default: false },
    isShadowBanned: { type: Boolean, default: false },
    isMuted: { type: Boolean, default: false },
    canSell: { type: Boolean, default: true },
    lastSeen: { type: Number, default: Date.now },
    status: { type: String, default: "offline" },
    lastIp: String,
    deviceInfo: String,
    loginHistory: [{ ip: String, timestamp: Number, device: String }]
});

const GlobalSettingsSchema = new mongoose.Schema({
    appName: { type: String, default: "Économie Virtuelle" },
    currencySymbol: { type: String, default: "$" },
    maintenanceMode: { type: Boolean, default: false },
    emergencyMode: { type: Boolean, default: false },
    globalTax: { type: Number, default: 0 }, // Taxe sur les ventes en %
    buyingEnabled: { type: Boolean, default: true },
    sellingEnabled: { type: Boolean, default: true },
    marketTrend: { type: String, default: "Stable" },
    primaryColor: { type: String, default: "#6200EE" },
    themeMode: { type: String, default: "dark" },
    minPrice: { type: Number, default: 1 },
    maxPrice: { type: Number, default: 1000000 },
    xpMultiplier: { type: Number, default: 1.0 },
    registrationEnabled: { type: Boolean, default: true }
});
const GlobalSettings = mongoose.model('GlobalSettings', GlobalSettingsSchema);

const ProductSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    stock: Number,
    category: String,
    imageUrl: String,
    sellerId: String,
    sellerName: String,
    isLimited: Boolean,
    isFeatured: { type: Boolean, default: false },
    rarity: { type: String, default: "COMMUN" }, // COMMUN, RARE, EPIC, LEGENDARY, ADMIN_ONLY
    createdAt: { type: Number, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
    senderId: String,
    senderName: String,
    receiverId: String,
    receiverName: String,
    amount: Number,
    details: String,
    type: String, // PURCHASE, GIFT, ADMIN_ADJUST, CANCELLED
    timestamp: { type: Number, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

TransactionSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

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

AuctionSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

const Auction = mongoose.model('Auction', AuctionSchema);

const LogSchema = new mongoose.Schema({
    action: String,
    details: String,
    timestamp: { type: Number, default: Date.now }
});

LogSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

const Log = mongoose.model('Log', LogSchema);

const MessageSchema = new mongoose.Schema({
    senderId: String,
    senderName: String,
    receiverId: { type: String, default: 'global' },
    content: String,
    timestamp: { type: Number, default: Date.now }
});

MessageSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

const Message = mongoose.model('Message', MessageSchema);

const ReportSchema = new mongoose.Schema({
    reporter: String,
    targetId: String,
    reason: String,
    timestamp: { type: Number, default: Date.now }
});

ReportSchema.set('toJSON', {
    transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
    }
});

// --- INITIALISATION ---
let globalSettings = {};

async function initDatabase() {
    try {
        let settings = await GlobalSettings.findOne();
        if (!settings) {
            settings = new GlobalSettings();
            await settings.save();
        }
        globalSettings = settings.toObject();

        const adminExists = await User.findOne({ username: "admin" });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash("admin123", 10);
            const admin = new User({
                username: "admin",
                password: hashedPassword,
                balance: 1000000,
                role: "SUPER_ADMIN",
                level: 100,
                reputation: 100,
                title: "Fondateur",
                statusMessage: "👑 Administrateur Suprême",
                badges: ["🛡️ Staff", "💎 Fondateur"],
                totalAccountValue: 1000000
            });
            await admin.save();
            console.log("👑 Compte ADMIN créé.");
        }
        console.log("✅ Système initialisé.");
    } catch(e) { console.error("❌ Erreur init :", e); }
}

mongoose.connect(MONGO_URI).then(() => {
    console.log("🍃 MongoDB Connected");
    initDatabase();
});

// --- HELPERS ---
async function addTransaction(data) {
    const t = new Transaction(data);
    await t.save();
    const io = app.get('io');
    if (io) io.to('admins').emit('new_transaction', t);
}

async function calculateTotalValue(user) {
    let inventoryValue = 0;
    try {
        const prods = await Product.find({ _id: { $in: user.inventory } });
        const multiplier = getMarketMultiplier();
        prods.forEach(p => {
            inventoryValue += (p.price * multiplier);
        });
    } catch(e) { console.error("Calc error:", e); }
    return Math.floor(user.balance + inventoryValue);
}

function getMarketMultiplier() {
    switch (globalSettings.marketTrend) {
        case "Inflation": return 2.0;
        case "Hausse": return 1.3;
        case "Baisse": return 0.7;
        case "Krak Boursier": return 0.3;
        case "Apocalypse": return 0.1;
        default: return 1.0;
    }
}

async function checkAchievements(user, io) {
    let updated = false;
    for (const ach of achievements) {
        if (!user.unlockedAchievements.includes(ach.id)) {
            let unlocked = false;
            if (ach.id === "a1" && user.inventory.length > 0) unlocked = true;
            if (ach.id === "a2" && user.balance >= 10000) unlocked = true;
            if (ach.id === "a3") {
                const count = await Product.countDocuments({ sellerId: user._id });
                if (count > 0) unlocked = true;
            }

            if (unlocked) {
                user.unlockedAchievements.push(ach.id);
                user.xp += ach.xpReward;
                io.to(user._id.toString()).emit('notification', { message: `🏆 SUCCÈS DÉBLOQUÉ : ${ach.name} !` });
                updated = true;
            }
        }
    }
    if (updated) await user.save();
}

async function addLog(action, details, io) {
    const log = new Log({ action, details });
    await log.save();
    if (io) io.to('admins').emit('new_log', log);
}

// --- SELF-PING TO KEEP ALIVE ON RENDER ---
const RENDER_EXTERNAL_URL = "https://mon-economie-server.onrender.com";

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

function keepAlive() {
    setInterval(() => {
        http.get(RENDER_EXTERNAL_URL + "/ping", (res) => {
            console.log(`Self-ping status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`Self-ping error: ${err.message}`);
        });
    }, 10 * 60 * 1000);
}

// --- MARKET TRENDS & AUCTION CLEANUP ---
setInterval(async () => {
    const trends = ["Stable", "Hausse", "Baisse", "Inflation", "Krak Boursier", "Apocalypse"];
    globalSettings.marketTrend = trends[Math.floor(Math.random() * trends.length)];

    let settings = await GlobalSettings.findOne();
    if (settings) {
        settings.marketTrend = globalSettings.marketTrend;
        await settings.save();
    }

    io.emit('settings_updated', globalSettings);
    io.emit('notification', { message: `La météo économique a changé : ${globalSettings.marketTrend} !` });
}, 30 * 60 * 1000);

// Background task to finish auctions
setInterval(async () => {
    const now = Date.now();
    const finishedAuctions = await Auction.find({ endTime: { $lte: now }, isFinished: false });

    for (const auction of finishedAuctions) {
        auction.isFinished = true;
        await auction.save();

        if (auction.highestBidderId) {
            const winner = await User.findById(auction.highestBidderId);
            const seller = await User.findById(auction.sellerId);

            if (winner && seller) {
                // Item is already in seller's inventory or removed from market?
                // Let's assume the auction transfers an item from seller inventory to winner
                seller.inventory = seller.inventory.filter(id => id !== auction.productId);
                winner.inventory.push(auction.productId);
                seller.balance += auction.highestBid;

                await seller.save();
                await winner.save();

                io.to(winner._id.toString()).emit('current_user', winner);
                io.to(seller._id.toString()).emit('current_user', seller);
                io.to(winner._id.toString()).emit('notification', { message: `🏆 Vous avez gagné l'enchère pour ${auction.productName} !` });
                io.to(seller._id.toString()).emit('notification', { message: `💰 Votre objet ${auction.productName} a été vendu aux enchères !` });
            }
        }
        io.emit('auction_update', auction);
    }
}, 30000); // Check every 30 seconds

// --- API ---
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Pseudo pris" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({
            username,
            password: hashedPassword,
            balance: globalSettings.defaultBalance,
            totalAccountValue: globalSettings.defaultBalance,
            statusMessage: "Je commence l'aventure !",
            title: "Nouveau"
        });
        await newUser.save();
        res.json({ token: jwt.sign({ userId: newUser._id }, JWT_SECRET), user: newUser });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (user && !user.isBanned && await bcrypt.compare(password, user.password)) {
            res.json({ token: jwt.sign({ userId: user._id }, JWT_SECRET), user });
        } else if (user && user.isBanned) res.status(403).json({ error: "Banni" });
        else res.status(401).json({ error: "Identifiants invalides" });
    } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }, transports: ['websocket'] });
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

    user.status = "online";
    user.lastSeen = Date.now();
    await user.save();

    socket.join(user._id.toString());
    if (user.role !== 'USER') socket.join('admins');

    io.emit('user_status', { userId: user._id, status: "online" });

    const currentProducts = await Product.find();
    const currentAuctions = await Auction.find({ isFinished: false });
    const leaderboard = await User.find().sort({ balance: -1 }).limit(20);
    const publicUsers = await User.find({}, 'username status statusMessage level').limit(50);
    const lastMessages = await Message.find({ receiverId: 'global' }).sort({ timestamp: -1 }).limit(50);

    socket.emit('initial_data', {
        currentUser: user,
        products: currentProducts,
        titles,
        settings: globalSettings,
        achievements,
        leaderboard,
        publicUsers,
        messages: lastMessages.reverse(),
        auctions: currentAuctions
    });

    if (user.role !== 'USER') {
        const allUsers = await User.find();
        const allLogs = await Log.find().sort({ timestamp: -1 }).limit(100);
        const allReports = await Report.find().sort({ timestamp: -1 });
        socket.emit('admin_data', { users: allUsers, logs: allLogs, reports: allReports });
    }

    socket.on('update_status', async (data) => {
        user.statusMessage = data.message;
        await user.save();
        io.to(user._id.toString()).emit('current_user', user);
    });

    socket.on('claim_daily', async () => {
        const now = Date.now();
        if (now - user.lastDaily > 24 * 3600 * 1000) {
            user.streak = (now - user.lastDaily < 48 * 3600 * 1000) ? user.streak + 1 : 1;
            const reward = 100 + (user.streak * 50);
            user.balance += reward;
            user.lastDaily = now;
            user.totalAccountValue = await calculateTotalValue(user);
            await user.save();
            io.to(user._id.toString()).emit('current_user', user);
            socket.emit('notification', { message: `🎁 Cadeau : +${reward} $` });
        } else socket.emit('notification', { message: "Déjà récupéré !" });
    });

    socket.on('claim_wheel', async () => {
        const now = Date.now();
        if (now - user.lastWheel > 24 * 3600 * 1000) {
            const reward = Math.floor(Math.random() * 450) + 50;
            user.balance += reward;
            user.lastWheel = now;
            await user.save();
            io.to(user._id.toString()).emit('current_user', user);
            socket.emit('notification', { message: `🎡 Roue : +${reward} $ !` });
        } else socket.emit('notification', { message: "Revenez demain !" });
    });

    socket.on('claim_chest', async () => {
        const now = Date.now();
        if (now - user.lastChest > 24 * 3600 * 1000) {
            const reward = Math.floor(Math.random() * 800) + 200;
            user.balance += reward;
            user.lastChest = now;
            await user.save();
            io.to(user._id.toString()).emit('current_user', user);
            socket.emit('notification', { message: `📦 Coffre : +${reward} $ !` });
        } else socket.emit('notification', { message: "Revenez demain !" });
    });

    socket.on('gift_money', async (data) => {
        const target = await User.findById(data.targetId);
        const amount = parseFloat(data.amount);
        if (target && amount > 0 && user.balance >= amount) {
            user.balance -= amount;
            target.balance += amount;
            await user.save(); await target.save();
            io.to(user._id.toString()).emit('current_user', user);
            io.to(target._id.toString()).emit('current_user', target);
            io.to(target._id.toString()).emit('notification', { message: `${user.username} vous a envoyé ${amount} $ !` });
            addLog("Transaction", `${user.username} -> ${target.username} (${amount}$)`, io);
        }
    });

    socket.on('buy_product', async (data) => {
        const product = await Product.findById(data.productId);
        if (!product) return;

        const multiplier = getMarketMultiplier();
        const currentPrice = product.price * multiplier;
        const alreadyOwned = user.inventory.includes(product._id.toString());
        const canAfford = user.balance >= currentPrice;
        const hasStock = product.stock > 0 || product.stock === -1;

        if (!alreadyOwned && canAfford && hasStock) {
            if (product.stock !== -1) product.stock--;
            await product.save();

            user.balance -= currentPrice;
            user.inventory.push(product._id.toString());
            user.totalAccountValue = await calculateTotalValue(user);

            user.xp += 50;
            if (user.xp >= user.level * 200) { user.level++; user.xp = 0; }
            await user.save();

            const seller = await User.findById(product.sellerId);
            if (seller) {
                seller.balance += currentPrice;
                seller.totalAccountValue = await calculateTotalValue(seller);
                await seller.save();
                io.to(seller._id.toString()).emit('current_user', seller);
                io.to(seller._id.toString()).emit('notification', { message: `Vendu : ${product.name} pour ${currentPrice.toInt()} $ !` });
            }

            io.to(user._id.toString()).emit('current_user', user);
            io.emit('product_updated', product);
            checkAchievements(user, io);
        } else if (alreadyOwned) {
            socket.emit('notification', { message: "Vous possédez déjà cet article !" });
        } else if (!hasStock) {
            socket.emit('notification', { message: "Article épuisé !" });
        } else {
            socket.emit('notification', { message: `Il vous manque ${Math.floor(currentPrice - user.balance)} $ !` });
        }
    });

    socket.on('admin_add_product', async (data) => {
        const newProduct = new Product({
            name: data.name,
            description: data.description,
            price: parseFloat(data.price),
            stock: parseInt(data.stock),
            category: data.category,
            imageUrl: data.imageUrl || "https://cdn-icons-png.flaticon.com/512/1170/1170577.png",
            sellerId: user._id,
            sellerName: user.username,
            isLimited: data.stock !== -1
        });
        await newProduct.save();
        const allProducts = await Product.find();
        io.emit('products_list', allProducts);
        addLog("Admin", `${user.username} a mis en vente : ${newProduct.name}`, io);
    });

    socket.on('admin_delete_product', async (data) => {
        if (user.role !== 'USER') {
            await Product.findByIdAndDelete(data.productId);
            const allProducts = await Product.find();
            io.emit('products_list', allProducts);
            addLog("Admin", `${user.username} a supprimé un produit`, io);
        }
    });

    socket.on('admin_modify_balance', async (data) => {
        if (user.role !== 'USER') {
            const target = await User.findById(data.userId);
            if (target) {
                const oldBalance = target.balance;
                target.balance = parseFloat(data.amount);
                await target.save();

                await addTransaction({
                    senderId: user._id, senderName: "ADMIN",
                    receiverId: target._id, receiverName: target.username,
                    amount: target.balance - oldBalance,
                    type: "ADMIN_ADJUST", details: "Ajustement manuel"
                });

                io.to(target._id.toString()).emit('current_user', target);
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `${user.username} a forcé le solde de ${target.username} à ${data.amount}`, io);
            }
        }
    });

    socket.on('admin_reset_economy', async () => {
        if (user.role === 'SUPER_ADMIN') {
            await User.updateMany({ role: 'USER' }, { $set: { balance: 1000, inventory: [], eventCurrency: 0 } });
            await Product.deleteMany({ sellerId: { $ne: user._id } });
            io.emit('notification', { message: "☢️ RÉINITIALISATION DE L'ÉCONOMIE !" });
            addLog("Admin", "RÉINITIALISATION TOTALE", io);
        }
    });

    socket.on('admin_update_global_settings', async (data) => {
        if (user.role === 'SUPER_ADMIN') {
            let settings = await GlobalSettings.findOne();
            if (!settings) settings = new GlobalSettings();
            Object.assign(settings, data);
            await settings.save();
            globalSettings = settings.toObject();
            io.emit('settings_updated', globalSettings);
            addLog("Admin", "Paramètres système modifiés", io);
        }
    });

    socket.on('admin_mute_user', async (data) => {
        if (user.role !== 'USER') {
            const target = await User.findById(data.userId);
            if (target) {
                target.isMuted = !target.isMuted;
                await target.save();
                io.to(target._id.toString()).emit('current_user', target);
                addLog("Admin", `${user.username} a ${target.isMuted ? 'réduit au silence' : 'débloqué la parole de'} ${target.username}`, io);
            }
        }
    });

    socket.on('admin_force_logout', (data) => {
        if (user.role !== 'USER') {
            io.to(data.userId).emit('banned');
            addLog("Admin", `Déconnexion forcée de ${data.userId}`, io);
        }
    });

    socket.on('admin_unban_user', async (data) => {
        if (user.role !== 'USER') {
            const target = await User.findById(data.userId);
            if (target) {
                target.isBanned = false;
                await target.save();
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `${user.username} a débanni ${target.username}`, io);
            }
        }
    });

    socket.on('admin_shadow_ban', async (data) => {
        if (user.role !== 'USER') {
            const target = await User.findById(data.userId);
            if (target) {
                target.isShadowBanned = !target.isShadowBanned;
                await target.save();
                io.to(target._id.toString()).emit('current_user', target);
                addLog("Admin", `${user.username} a ${target.isShadowBanned ? 'shadow ban' : 'un-shadow ban'} ${target.username}`, io);
            }
        }
    });

    socket.on('admin_global_reward', async (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const reward = parseFloat(data.amount);
            await User.updateMany({ role: 'USER' }, { $inc: { balance: reward } });
            io.emit('notification', { message: `💸 PLUIE DE RÉCOMPENSES : +${reward} $ pour tout le monde !` });
            addLog("Admin", `Récompense globale de ${reward} $ distribuée`, io);
        }
    });

    socket.on('admin_global_announcement', (data) => {
        if (user.role !== 'USER') {
            io.emit('global_announcement', { text: data.text });
            addLog("Admin", `Annonce globale: ${data.text}`, io);
        }
    });

    socket.on('admin_spawn_item', async (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const target = await User.findById(data.userId);
            const product = await Product.findById(data.productId);
            if (target && product) {
                target.inventory.push(product._id.toString());
                await target.save();
                io.to(target._id.toString()).emit('current_user', target);
                io.to(target._id.toString()).emit('notification', { message: `🎁 Un admin vous a donné : ${product.name}` });
                addLog("Admin", `Item ${product.name} spawn pour ${target.username}`, io);
            }
        }
    });

    socket.on('admin_ban_user', async (data) => {
        if (user.role !== 'USER') {
            const target = await User.findById(data.userId);
            if (target && target.role === 'USER') {
                target.isBanned = true;
                await target.save();
                io.to(target._id.toString()).emit('banned');
                io.to('admins').emit('admin_user_updated', target);
                addLog("Admin", `${user.username} a banni ${target.username}`, io);
            }
        }
    });

    socket.on('super_admin_update_settings', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            Object.assign(globalSettings, data);
            io.emit('settings_updated', globalSettings);
            addLog("Admin", "Paramètres globaux mis à jour", io);
        }
    });

    socket.on('send_message', async (data) => {
        if (user.isMuted) return socket.emit('notification', { message: "Vous êtes réduit au silence !" });
        const msg = new Message({ senderId: user._id, senderName: user.username, content: data.content });
        await msg.save();
        if (!user.isShadowBanned) io.emit('new_message', msg);
        else socket.emit('new_message', msg); // Ne voit que son message
    });

    socket.on('report_user', async (data) => {
        const report = new Report({ reporter: user.username, targetId: data.userId, reason: data.reason });
        await report.save();
        io.to('admins').emit('new_report', report);
    });

    socket.on('start_auction', async (data) => {
        let product;
        if (user.role !== 'USER') {
            product = await Product.findById(data.productId);
        } else {
            product = await Product.findOne({ _id: data.productId, sellerId: user._id });
        }

        if (product) {
            const auction = new Auction({
                productId: product._id,
                productName: product.name,
                sellerId: product.sellerId,
                sellerName: product.sellerName,
                highestBid: product.price * getMarketMultiplier(),
                endTime: Date.now() + (data.durationMinutes * 60000)
            });
            await auction.save();
            io.emit('new_auction', auction);
            addLog("Market", `${user.username} a lancé une enchère pour ${product.name}`, io);
        }
    });

    socket.on('bid_auction', async (data) => {
        const auction = await Auction.findById(data.auctionId);
        const bid = parseFloat(data.amount);
        if (auction && !auction.isFinished && bid > auction.highestBid && user.balance >= bid) {
            auction.highestBid = bid;
            auction.highestBidderId = user._id;
            auction.highestBidderName = user.username;
            await auction.save();
            io.emit('auction_update', auction);
        }
    });

    socket.on('add_friend', async (data) => {
        const target = await User.findById(data.targetId);
        if (target && target._id.toString() !== user._id.toString()) {
            const already = user.friends.some(f => f.userId === target._id.toString());
            if (!already) {
                user.friends.push({ userId: target._id.toString(), status: 'pending' });
                await user.save();
                io.to(target._id.toString()).emit('notification', { message: `${user.username} vous a envoyé une demande d'ami !` });
                socket.emit('notification', { message: "Demande envoyée !" });
            }
        }
    });

    socket.on('like_user', async (data) => {
        const target = await User.findById(data.userId);
        if (target && target._id.toString() !== user._id.toString()) {
            target.reputation += 1;
            target.xp += 10;
            await target.save();
            io.to(target._id.toString()).emit('current_user', target);
            io.to(target._id.toString()).emit('notification', { message: `💖 ${user.username} a aimé votre profil !` });
            socket.emit('notification', { message: "Mention J'aime envoyée !" });
        }
    });

    socket.on('disconnect', async () => {
        user.status = "offline";
        await user.save();
        io.emit('user_status', { userId: user._id, status: "offline" });
    });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log("🚀 ECO-SYSTEM FULL LOADED");
    keepAlive();
});
