require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Connexion à la base de données Cloud (MongoDB Atlas)
// Si aucune URL n'est fournie, on utilise une base locale pour ne pas bloquer le démarrage
const mongoURI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/economie";
mongoose.connect(mongoURI)
    .then(() => console.log("✅ Base de données Cloud connectée"))
    .catch(err => console.error("❌ Erreur DB:", err));

// Modèles de données
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 100.0 },
    role: { type: String, default: 'USER' },
    level: { type: Number, default: 1 },
    reputation: { type: Number, default: 0 },
    xp: { type: Number, default: 0 },
    title: String
});
const User = mongoose.model('User', UserSchema);

const ProductSchema = new mongoose.Schema({
    name: String,
    description: String,
    price: Number,
    stock: Number,
    category: String,
    sellerId: String,
    imageUrl: String,
    createdAt: { type: Number, default: Date.now }
});
const Product = mongoose.model('Product', ProductSchema);

// --- AUTHENTIFICATION ---
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        const token = jwt.sign({ userId: newUser._id }, process.env.JWT_SECRET || "secret_temp");
        res.json({ token, user: newUser });
    } catch (e) { res.status(400).json({ error: "Utilisateur déjà existant" }); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || "secret_temp");
        res.json({ token, user });
    } else { res.status(401).json({ error: "Identifiants invalides" }); }
});

// --- TEMPS RÉEL (SOCKET.IO) ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token) {
        jwt.verify(token, process.env.JWT_SECRET || "secret_temp", (err, decoded) => {
            if (err) return next(new Error("Auth Error"));
            socket.userId = decoded.userId;
            next();
        });
    } else next(new Error("Auth Error"));
});

io.on('connection', async (socket) => {
    socket.join(socket.userId);

    // Envoyer les produits au démarrage
    const products = await Product.find();
    socket.emit('products_list', products);

    socket.on('buy_product', async (data) => {
        const product = await Product.findById(data.productId);
        const user = await User.findById(socket.userId);

        if (product && user && product.stock > 0 && user.balance >= product.price) {
            product.stock -= 1;
            user.balance -= product.price;
            await product.save();
            await user.save();

            io.to(socket.userId).emit('update_balance', { balance: user.balance });
            io.emit('product_sold', product);
        }
    });

    socket.on('send_message', (data) => {
        const msg = { id: uuidv4(), senderId: socket.userId, ...data, timestamp: Date.now() };
        io.to(data.receiverId).emit('new_message', msg);
        io.to(socket.userId).emit('new_message', msg);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur Économie en ligne sur le port ${PORT}`);
});
