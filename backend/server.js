const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary'); // Cloudinary Storage Import
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const nodemailer = require('nodemailer'); // --- NODEMAILER IMPORT FOR OTP ---

const app = express();
require('dotenv').config();

// --- 🚀 CRITICAL TIMEOUT FIX: GMAIL TRANSPORTER VIA SECURE PORT 465 (SSL) ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,                  // Render network par timeout se bachne ke liye Port 465 Secure SSL mandatory hai
    secure: true,               // True strictly for port 465
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // Aapka full Gmail address
        pass: process.env.EMAIL_PASS  // Aapka 16-digit Google App Password (bina kisi space ke)
    },
    connectionTimeout: 15000,   // 15 seconds connection timeout buffer
    greetingTimeout: 15000,
    socketTimeout: 20000,
    family: 4                   // Forces IPv4 strictly to avoid DNS/IPv6 routing failures on Render
});

// SMTP Connection Check (Server starting logs me status dikh jayega)
transporter.verify((err, success) => {
    if (err) {
        console.error("SMTP Configuration Error:", err.message);
    } else {
        console.log("SMTP Server Ready - Gmail Gateway Connected Successfully! 🎉");
    }
});

// Temporary memory store for OTP verification
let otpStore = {};

// --- MYSQL CONNECTION (Aiven) ---
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    multipleStatements: true,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) {
        console.error('Aiven Connection Error: ' + err.message);
        return;
    }
    console.log('Connected to Aiven Cloud MySQL!');

    // Automatic Table Creation Script (Fixed with phone column)
    const sql = `
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        role VARCHAR(50),
        phone VARCHAR(20)
    );
    CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        price DECIMAL(10,2),
        city VARCHAR(255),
        quantity INT,
        image VARCHAR(255),
        admin_id INT
    );
    CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        product_id INT,
        customer_name VARCHAR(255),
        address TEXT,
        phone VARCHAR(20),
        status VARCHAR(50) DEFAULT 'Pending',
        order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

    db.query(sql, (err) => {
        if (err) console.log("Table setup error:", err.message);
        else console.log("Success: Sabhi tables Aiven par ban gayi hain!");
    });
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- CLOUDINARY CONFIGURATION ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cloudinary Storage Link with Multer
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'cityshop_products', 
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
});

const upload = multer({ storage: storage });

// --- ROUTES ---

// --- ROUTE: SEND OTP ---
app.post('/send-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required!" });

    // 6-digit random code generate karo
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Memory me temporary save karo (5 mins expiry)
    otpStore[email] = {
        otp: otp,
        expires: Date.now() + 5 * 60 * 1000
    };

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'City Shop Agro - Registration OTP Verification',
        html: `
            <div style="font-family: 'Inter', sans-serif; max-width: 500px; margin: auto; padding: 20px; background: #161616; color: white; border-radius: 15px; border: 1px solid #74c947;">
                <h2 style="color: #74c947; text-align: center;">CITY SHOP AGRO</h2>
                <p>Bhai, aapke account registration ke liye OTP niche diya gaya hai:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 5px; text-align: center; color: #fff; margin: 20px 0; background: rgba(116, 201, 71, 0.2); padding: 10px; border-radius: 10px;">
                    ${otp}
                </div>
                <p style="color: #a0a0a0; font-size: 12px; text-align: center;">Yeh OTP sirf 5 minute ke liye hi valid hai. Kisi ke sath share na karein.</p>
            </div>
        `
    };

    transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
            console.error("Nodemailer Email Error:", err);
            return res.status(500).json({ success: false, message: "Server network error while dispatching OTP: " + err.message });
        }
        console.log("Email Sent Successfully!");
        res.json({ success: true, message: "OTP sent successfully to your email!" });
    });
});

// --- ROUTE: REGISTER USER WITH OTP VERIFICATION ---
app.post('/register-user', (req, res) => {
    const { username, email, password, role, otp } = req.body;

    if (!otpStore[email] || otpStore[email].otp !== otp) {
        return res.json({ success: false, message: "wrong OTP, check again!" });
    }

    if (Date.now() > otpStore[email].expires) {
        delete otpStore[email];
        return res.json({ success: false, message: "OTP is Expired ! send new otp." });
    }

    delete otpStore[email]; // Clear OTP after usage

    const checkSql = "SELECT * FROM users WHERE email = ?";
    db.query(checkSql, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) {
            return res.json({ success: false, message: "Email already exists!" });
        }

        const insertSql = "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)";
        db.query(insertSql, [username, email, password, role || 'customer'], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: "User Registered Successfully!" });
        });
    });
});

// REGISTER (Old Route)
app.post('/register', (req, res) => {
    const { username, email, password, role } = req.body;
    const sql = "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)";
    db.query(sql, [username, email, password, role || 'customer'], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.json({ success: false, message: "Email already exists!" });
            }
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, message: "User Registered!" });
    });
});

// LOGIN
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM users WHERE email = ? AND password = ?";
    db.query(sql, [email, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (results.length > 0) {
            const user = results[0];
            res.json({
                success: true,
                user: { id: user.id, email: user.email, role: user.role, username: user.username }
            });
        } else {
            res.json({ success: false, message: "Invalid email or password!" });
        }
    });
});

// ADD PRODUCT
app.post('/add-product', upload.single('image'), (req, res) => {
    const { name, price, city, quantity, admin_id } = req.body; 
    const image = req.file ? req.file.path : null; 

    const sql = "INSERT INTO products (name, price, city, quantity, image, admin_id) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sql, [name, price, city, quantity, image, admin_id], (err, result) => {
        if (err) return res.status(500).send("Database Error: " + err.message);
        res.send("Product Added Successfully!");
    });
});

// GET ALL PRODUCTS
app.get('/get-products', (req, res) => {
    const city = req.query.city || 'All';
    let sql = "SELECT * FROM products";
    let params = [];

    if (city !== 'All') {
        sql = "SELECT * FROM products WHERE city = ?";
        params = [city];
    }

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, products: results });
    });
});

// ADMIN: VIEW OWN PRODUCTS
app.get('/admin-products/:adminId', (req, res) => {
    const sql = "SELECT * FROM products WHERE admin_id = ?";
    db.query(sql, [req.params.adminId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, products: results });
    });
});

// GET SINGLE PRODUCT FOR EDITING
app.get('/get-product/:id', (req, res) => {
    const sql = "SELECT * FROM products WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

// ADMIN: UPDATE PRODUCT
app.put('/update-product/:id', upload.single('image'), (req, res) => {
    const productId = req.params.id;
    if (!req.body || Object.keys(req.body).length === 0) return res.status(400).send("Form empty!");
    const { name, price, city, quantity } = req.body;

    if (req.file) {
        const newImage = req.file.path; 
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=?, image=? WHERE id=?";
        db.query(sql, [name, price, city, quantity, newImage, productId], (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated with new image!");
        });
    } else {
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=? WHERE id=?";
        db.query(sql, [name, price, city, quantity, productId], (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated successfully!");
        });
    }
});

// DELETE PRODUCT
app.delete('/delete-product/:id', (req, res) => {
    const deleteSql = "DELETE FROM products WHERE id = ?";
    db.query(deleteSql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.send("Product deleted successfully!");
    });
});

// PLACE ORDER
app.post('/place-order', (req, res) => {
    const { user_id, product_id, name, address, phone } = req.body;
    const sql = "INSERT INTO orders (user_id, product_id, customer_name, address, phone) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [user_id, product_id, name, address, phone], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, message: "Order Placed!" });
    });
});

// GET MY ORDERS
app.get('/my-orders/:userId', (req, res) => {
    const sql = `
        SELECT orders.id, orders.address, orders.status, orders.order_date,
               products.name AS product_name, products.image, products.price 
        FROM orders 
        JOIN products ON orders.product_id = products.id 
        WHERE orders.user_id = ? 
        ORDER BY orders.id DESC`;
        
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, orders: results });
    });
});

// GET ALL ORDERS FOR ADMIN
app.get('/get-all-orders', (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// UPDATE PROFILE
app.put('/update-profile/:adminid', (req, res) => {
    const userId = req.params.adminid;
    const { username, email, phone, password } = req.body;

    let sql = "UPDATE users SET username=?, email=?, phone=? WHERE id=?";
    let params = [username, email, phone, userId];

    if (password && password.trim() !== "") {
        sql = "UPDATE users SET username=?, email=?, phone=?, password=? WHERE id=?";
        params = [username, email, phone, password, userId];
    }

    db.query(sql, params, (err, result) => {
        if (err) return res.status(500).send(err);
        db.query("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
            res.json({ message: "Profile Updated!", user: user[0] });
        });
    });
});

// Auto Reconnect Logic
function handleDisconnect() {
    db.on('error', function(err) {
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.log('DB connection lost. Reconnecting...');
        } else {
            throw err;
        }
    });
}
handleDisconnect();

const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

// Google Client ID Yahan Daalein
const GOOGLE_CLIENT_ID = "926493004740-b049qpm9kg1ofsuqpi414hbuuhjfd8o4.apps.googleusercontent.com"; 

// Google Sign-In Trigger Function
function googleSignIn() {
    if (typeof google === "undefined") {
        alert("Google SDK loading... Please wait a second and try again.");
        return;
    }

    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleResponse
    });

    google.accounts.id.prompt(); // Shows One-Tap popup or account selector
}

// Token Response Callback Handler
function handleGoogleResponse(response) {
    const idToken = response.credential; // ID Token from Google
    const selectedRole = document.getElementById("roleSelect") ? document.getElementById("roleSelect").value : "farmer";

    const loader = document.getElementById("loginLoader") || document.getElementById("regLoader");
    const loaderText = document.getElementById("loaderText");

    if (loader) {
        loader.style.display = "flex";
        if (loaderText) loaderText.innerText = "Authenticating with Google...";
    }

    // Backend API Request
    fetch("https://cityshobackend.onrender.com/google-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token: idToken,
            role: selectedRole
        })
    })
    .then(res => res.json())
    .then(res => {
        if (loader) loader.style.display = "none";

        if (res.success) {
            alert("Google Sign-In Successful!");
            localStorage.setItem("user", JSON.stringify(res.user));
            window.location.href = res.user.role === "admin" ? "admin.html" : "view.html";
        } else {
            alert(res.message || "Google Authentication failed!");
        }
    })
    .catch(err => {
        if (loader) loader.style.display = "none";
        console.error("Google Auth Error:", err);
        alert("Server network error during Google Login!");
    });
}

const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client("926493004740-b049qpm9kg1ofsuqpi414hbuuhjfd8o4.apps.googleusercontent.com");

app.post('/google-auth', async (req, res) => {
    const { token, role } = req.body;

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "926493004740-b049qpm9kg1ofsuqpi414hbuuhjfd8o4.apps.googleusercontent.com",
        });

        const payload = ticket.getPayload();
        const { email, name, picture, sub: googleId } = payload;

        // Check if user already exists in DB
        let user = await User.findOne({ email: email });

        if (!user) {
            // New User Registration via Google
            user = new User({
                username: name,
                email: email,
                role: role || 'farmer',
                isGoogleUser: true,
                googleId: googleId
            });
            await user.save();
        }

        res.json({
            success: true,
            message: "Authentication successful",
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("Google Token Verification Error:", error);
        res.status(400).json({ success: false, message: "Invalid Google Token" });
    }
});