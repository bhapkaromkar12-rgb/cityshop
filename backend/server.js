const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

const app = express();
require('dotenv').config();

// --- STRICT ADMIN LOGIN CREDENTIALS ---
const ADMIN_EMAIL = "bhapkaromkar12@gmail.com";
const ADMIN_PASS = "Chiku@2121";

// --- GMAIL TRANSPORTER SETUP ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    family: 4
});

transporter.verify((err, success) => {
    if (err) {
        console.error("SMTP Configuration Error:", err.message);
    } else {
        console.log("SMTP Server Ready - Gmail Gateway Connected Successfully! 🎉");
    }
});

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

    // 1. Initial Table Creation Setup
    const sql = `
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        role VARCHAR(50) DEFAULT 'farmer',
        phone VARCHAR(20),
        company_name VARCHAR(255),
        state VARCHAR(100),
        district VARCHAR(100),
        taluka VARCHAR(100),
        village VARCHAR(100),
        pincode VARCHAR(10),
        document_url VARCHAR(255),
        status VARCHAR(50) DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
        if (err) {
            console.log("Table setup error:", err.message);
            return;
        }
        console.log("Success: Sabhi tables Aiven par verified hain!");

        // 2. Safe Dynamic Schema Migration (Checks INFORMATION_SCHEMA)
        const requiredColumns = [
            { name: 'phone', definition: 'VARCHAR(20)' },
            { name: 'company_name', definition: 'VARCHAR(255)' },
            { name: 'state', definition: 'VARCHAR(100)' },
            { name: 'district', definition: 'VARCHAR(100)' },
            { name: 'taluka', definition: 'VARCHAR(100)' },
            { name: 'village', definition: 'VARCHAR(100)' },
            { name: 'pincode', definition: 'VARCHAR(10)' },
            { name: 'document_url', definition: 'VARCHAR(255)' },
            { name: 'status', definition: "VARCHAR(50) DEFAULT 'approved'" }
        ];

        requiredColumns.forEach(col => {
            const checkColSql = `
                SELECT COLUMN_NAME 
                FROM INFORMATION_SCHEMA.COLUMNS 
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = ?
            `;

            db.query(checkColSql, [process.env.DB_NAME, col.name], (chkErr, results) => {
                if (chkErr) {
                    console.error(`Error checking column ${col.name}:`, chkErr.message);
                    return;
                }

                if (results.length === 0) {
                    const alterSql = `ALTER TABLE users ADD COLUMN ${col.name} ${col.definition}`;
                    db.query(alterSql, (alterErr) => {
                        if (alterErr) {
                            console.error(`Failed to add column ${col.name}:`, alterErr.message);
                        } else {
                            console.log(`Successfully added missing column: ${col.name}`);
                        }
                    });
                }
            });
        });
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

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'cityshop_products', 
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'pdf'],
    },
});

const upload = multer({ storage: storage });

// --- ADMIN SPECIFIC ROUTES ---

// 1. STRICT ADMIN LOGIN
app.post('/admin-login', (req, res) => {
    const { email, password } = req.body;

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASS) {
        return res.status(401).json({ success: false, message: "Invalid Admin Credentials!" });
    }

    res.json({
        success: true,
        message: "Welcome Super Admin!",
        user: { name: "Omkar Bhapkar (Admin)", email: ADMIN_EMAIL, role: "admin" }
    });
});

// 2. GET PENDING SELLER APPLICATIONS
app.get('/admin/seller-requests', (req, res) => {
    const sql = "SELECT id, username, email, phone, company_name, state, district, village, document_url, status FROM users WHERE role = 'seller' AND status = 'pending'";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, requests: results });
    });
});

// 3. GET ADMIN STATS & VERIFIED SELLERS
app.get('/admin/stats-users', (req, res) => {
    const sqlFarmers = "SELECT COUNT(*) AS totalFarmers FROM users WHERE role = 'farmer'";
    const sqlSellers = "SELECT COUNT(*) AS totalSellers FROM users WHERE role = 'seller' AND status = 'approved'";
    const sqlPending = "SELECT COUNT(*) AS pendingRequests FROM users WHERE role = 'seller' AND status = 'pending'";
    const sqlApprovedSellers = "SELECT id, username AS name, email, phone, company_name, pincode FROM users WHERE role = 'seller' AND status = 'approved'";

    db.query(`${sqlFarmers}; ${sqlSellers}; ${sqlPending}; ${sqlApprovedSellers}`, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({
            success: true,
            stats: {
                totalFarmers: results[0][0].totalFarmers,
                totalSellers: results[1][0].totalSellers,
                pendingRequests: results[2][0].pendingRequests
            },
            approvedSellers: results[3]
        });
    });
});

// 4. APPROVE OR REJECT SELLER STATUS (FIXED DOUBLE/UNDEFINED ERROR)
app.post('/admin/update-seller-status', (req, res) => {
    const rawUserId = req.body.userId || req.body.id;
    const { status } = req.body;

    // Check for missing or string "undefined" values
    if (!rawUserId || rawUserId === 'undefined' || isNaN(Number(rawUserId))) {
        return res.status(400).json({ 
            success: false, 
            message: "Invalid or missing User ID. Please make sure the ID is passed correctly from Frontend." 
        });
    }

    const userId = parseInt(rawUserId, 10); // Parse strictly as Integer

    const sql = "UPDATE users SET status = ? WHERE id = ?";
    db.query(sql, [status, userId], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "User not found or status already updated." });
        }

        res.json({ success: true, message: `Seller application ${status} successfully!` });
    });
});

// --- EXISTING ROUTES ---

// ROUTE: SEND OTP
app.post('/send-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required!" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp, expires: Date.now() + 5 * 60 * 1000 };

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
        if (err) return res.status(500).json({ success: false, message: "Server network error while dispatching OTP: " + err.message });
        res.json({ success: true, message: "OTP sent successfully to your email!" });
    });
});

// ROUTE: REGISTER USER WITH OTP
app.post('/register-user', (req, res) => {
    const { username, email, password, role, otp } = req.body;

    if (!otpStore[email] || otpStore[email].otp !== otp) {
        return res.json({ success: false, message: "wrong OTP, check again!" });
    }

    if (Date.now() > otpStore[email].expires) {
        delete otpStore[email];
        return res.json({ success: false, message: "OTP is Expired ! send new otp." });
    }

    delete otpStore[email];

    const checkSql = "SELECT * FROM users WHERE email = ?";
    db.query(checkSql, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) return res.json({ success: false, message: "Email already exists!" });

        const insertSql = "INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)";
        db.query(insertSql, [username, email, password, role || 'customer'], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: "User Registered Successfully!" });
        });
    });
});

// ROUTE: APPLY FOR SELLER WITH DOCUMENT UPLOAD
app.post('/apply-seller', upload.single('document'), (req, res) => {
    const { username, email, phone, password, companyName, state, district, taluka, village, pincode } = req.body;
    const documentUrl = req.file ? req.file.path : null;

    const checkSql = "SELECT * FROM users WHERE email = ?";
    db.query(checkSql, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) return res.json({ success: false, message: "Email already registered!" });

        const sql = `INSERT INTO users (username, email, phone, password, role, company_name, state, district, taluka, village, pincode, document_url, status) 
                     VALUES (?, ?, ?, ?, 'seller', ?, ?, ?, ?, ?, ?, ?, 'pending')`;
        db.query(sql, [username, email, phone, password, companyName, state, district, taluka, village, pincode, documentUrl], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: "Seller application submitted to Admin!" });
        });
    });
});

// LOGIN
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    // Direct redirection for Admin credentials
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
        return res.json({
            success: true,
            user: { id: 0, email: ADMIN_EMAIL, role: 'admin', username: 'Omkar Bhapkar (Admin)' }
        });
    }

    const sql = "SELECT * FROM users WHERE email = ? AND password = ?";
    db.query(sql, [email, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (results.length > 0) {
            const user = results[0];
            if (user.role === 'seller' && user.status === 'pending') {
                return res.json({ success: false, message: "Your seller application is pending Admin approval!" });
            }
            res.json({
                success: true,
                user: { id: user.id, email: user.email, role: user.role, username: user.username }
            });
        } else {
            res.json({ success: false, message: "Invalid email or password!" });
        }
    });
});

// GOOGLE AUTHENTICATION
const GOOGLE_CLIENT_ID = "926493004740-b049qpm9kg1ofsuqpi414hbuuhjfd8o4.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.post('/google-auth', async (req, res) => {
    const { token, role } = req.body;

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, name } = payload;

        const checkSql = "SELECT * FROM users WHERE email = ?";
        db.query(checkSql, [email], (err, results) => {
            if (err) return res.status(500).json({ success: false, message: err.message });

            if (results.length > 0) {
                const user = results[0];
                return res.json({
                    success: true,
                    message: "Authentication successful",
                    user: { id: user.id, username: user.username, email: user.email, role: user.role }
                });
            } else {
                const insertSql = "INSERT INTO users (username, email, role, password) VALUES (?, ?, ?, 'GOOGLE_AUTH')";
                db.query(insertSql, [name, email, role || 'farmer'], (err, result) => {
                    if (err) return res.status(500).json({ success: false, message: err.message });
                    res.json({
                        success: true,
                        message: "Registration successful",
                        user: { id: result.insertId, username: name, email: email, role: role || 'farmer' }
                    });
                });
            }
        });
    } catch (error) {
        console.error("Google Token Verification Error:", error);
        res.status(400).json({ success: false, message: "Invalid Google Token" });
    }
});

// PRODUCT MANAGEMENT ROUTES
app.post('/add-product', upload.single('image'), (req, res) => {
    const { name, price, city, quantity, admin_id } = req.body; 
    const image = req.file ? req.file.path : null; 

    const sql = "INSERT INTO products (name, price, city, quantity, image, admin_id) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sql, [name, price, city, quantity, image, admin_id], (err, result) => {
        if (err) return res.status(500).send("Database Error: " + err.message);
        res.send("Product Added Successfully!");
    });
});

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

app.get('/admin-products/:adminId', (req, res) => {
    const sql = "SELECT * FROM products WHERE admin_id = ?";
    db.query(sql, [req.params.adminId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, products: results });
    });
});

app.get('/get-product/:id', (req, res) => {
    const sql = "SELECT * FROM products WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

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

app.delete('/delete-product/:id', (req, res) => {
    const deleteSql = "DELETE FROM products WHERE id = ?";
    db.query(deleteSql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.send("Product deleted successfully!");
    });
});

// ORDERS
app.post('/place-order', (req, res) => {
    const { user_id, product_id, name, address, phone } = req.body;
    const sql = "INSERT INTO orders (user_id, product_id, customer_name, address, phone) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [user_id, product_id, name, address, phone], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, message: "Order Placed!" });
    });
});

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

// SERVER LISTEN
const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});