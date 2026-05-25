require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket']
});

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key";

// --- DONNÉES EN MÉMOIRE ---
let users = [];
let products = [
    { id: "p1", name: "Pack Fondateur", description: "Un pack exclusif pour les premiers arrivés.", price: 0, stock: 100, category: "Événement", imageUrl: "https://cdn-icons-png.flaticon.com/512/1063/1063376.png" },
    { id: "p2", name: "Grade VIP+", description: "Deviens une légende de l'économie.", price: 15000, stock: 10, category: "Grades", imageUrl: "https://cdn-icons-png.flaticon.com/512/2583/2583344.png" },
    { id: "p3", name: "Lingot d'Or", description: "Valeur refuge.", price: 5000, stock: 50, category: "Ressources", imageUrl: "https://cdn-icons-png.flaticon.com/512/2481/2481134.png" }
];
let messages = [];
let logs = [];
let transactions = [];

// --- LOGIQUE ADMIN ---
async function initAdmin() {
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const admin = {
        id: "admin-id", username: "admin", password: hashedPassword,
        balance: 1000000, role: "SUPER_ADMIN", level: 100, xp: 0, reputation: 100, title: "Créateur", isBanned: false
    };
    users.push(admin);
}
initAdmin();

function addLog(action, details) {
    const log = { id: uuidv4(), action, details, timestamp: Date.now() };
    logs.unshift(log);
    if (logs.length > 100) logs.pop();
    io.to('admins').emit('new_log', log);
}

// --- ROUTES API ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (users.find(u => u.username === username)) return res.status(400).json({ error: "Pseudo déjà pris" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
        id: uuidv4(), username, password: hashedPassword, balance: 1000,
        role: 'USER', level: 1, xp: 0, reputation: 0, title: "Nouveau", isBanned: false
    };
    users.push(user);
    addLog("Register", `Nouvel utilisateur: ${username}`);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ token, user });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if (user && !user.isBanned && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user.id }, JWT_SECRET);
        res.json({ token, user });
    } else if (user && user.isBanned) {
        res.status(403).json({ error: "Votre compte est banni" });
    } else res.status(401).json({ error: "Identifiants invalides" });
});

// --- TEMPS RÉEL ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth error"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Auth error"));
        socket.userId = decoded.userId;
        next();
    });
});

io.on('connection', (socket) => {
    const user = users.find(u => u.id === socket.userId);
    if (!user) return;

    socket.join(socket.userId);
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
        socket.join('admins');
    }

    console.log(`✅ ${user.username} est en ligne`);

    socket.emit('current_user', user);
    socket.emit('products_list', products);
    socket.emit('messages_history', messages.filter(m => m.receiverId === user.id || m.senderId === user.id || m.receiverId === 'global'));

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
        socket.emit('admin_data', { users, logs, transactions });
    }

    socket.on('buy_product', (data) => {
        const product = products.find(p => p.id === data.productId);
        if (product && product.stock > 0 && user.balance >= product.price) {
            product.stock--;
            user.balance -= product.price;
            user.xp += 50;
            if (user.xp >= user.level * 200) { user.level++; user.xp = 0; }

            const tx = { id: uuidv4(), senderId: user.id, receiverId: product.sellerId, amount: product.price, details: `Achat: ${product.name}`, timestamp: Date.now() };
            transactions.unshift(tx);

            io.to(socket.userId).emit('current_user', user);
            io.emit('product_sold', product);
            io.to('admins').emit('new_transaction', tx);
            io.to(socket.userId).emit('notification', { message: `Achat réussi: ${product.name} !` });
            addLog("Purchase", `${user.username} a acheté ${product.name}`);
        }
    });

    socket.on('send_message', (data) => {
        const msg = { id: uuidv4(), senderId: user.id, senderName: user.username, content: data.content, receiverId: data.receiverId || 'global', timestamp: Date.now() };
        messages.push(msg);
        if (msg.receiverId === 'global') io.emit('new_message', msg);
        else {
            io.to(msg.receiverId).emit('new_message', msg);
            io.to(user.id).emit('new_message', msg);
        }
    });

    // --- ACTIONS ADMIN ---
    socket.on('admin_announcement', (data) => {
        if (user.role !== 'USER') {
            io.emit('global_announcement', { text: data.text });
            addLog("Announcement", `${user.username}: ${data.text}`);
        }
    });

    socket.on('admin_modify_balance', (data) => {
        if (user.role === 'SUPER_ADMIN') {
            const target = users.find(u => u.id === data.userId);
            if (target) {
                target.balance = data.amount;
                io.to(target.id).emit('current_user', target);
                io.to('admins').emit('admin_user_updated', target);
                addLog("BalanceMod", `${user.username} a mis le solde de ${target.username} à ${data.amount}`);
            }
        }
    });

    socket.on('admin_ban_user', (data) => {
        if (user.role !== 'USER') {
            const target = users.find(u => u.id === data.userId);
            if (target && target.role === 'USER') {
                target.isBanned = true;
                io.to(target.id).emit('banned');
                io.to('admins').emit('admin_user_updated', target);
                addLog("Ban", `${user.username} a banni ${target.username}`);
            }
        }
    });

    socket.on('admin_add_product', (data) => {
        if (user.role !== 'USER') {
            const newProduct = { id: uuidv4(), ...data, createdAt: Date.now() };
            products.push(newProduct);
            io.emit('new_product', newProduct);
            addLog("AddProduct", `${user.username} a ajouté ${data.name}`);
        }
    });

    socket.on('admin_delete_product', (data) => {
        if (user.role !== 'USER') {
            products = products.filter(p => p.id !== data.productId);
            io.emit('products_list', products);
            addLog("DeleteProduct", `${user.username} a supprimé le produit ${data.productId}`);
        }
    });

    socket.on('disconnect', () => console.log(`❌ ${user.username} déconnecté`));
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 SERVEUR COMPLET EN LIGNE"));
