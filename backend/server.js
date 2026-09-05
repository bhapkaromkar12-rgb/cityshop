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
const EMAIL_USER = process.env.EMAIL_USER || "agrotechh12@gmail.com";
const EMAIL_PASS = process.env.EMAIL_PASS;   // set this in Render env vars — your 16-char App Password

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    family: 4,              // force IPv4 — Render free tier blocks outbound IPv6
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 45000,
    tls: { rejectUnauthorized: false }
});

transporter.verify((err, success) => {
    if (err) {
        console.error("SMTP Error:", err.code, "|", err.message);
        console.error("EMAIL_USER:", EMAIL_USER, "| EMAIL_PASS set:", !!EMAIL_PASS);
    } else {
        console.log("SMTP Ready ✓ — sending as:", EMAIL_USER);
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

// 4. APPROVE OR REJECT SELLER STATUS
app.post('/admin/update-seller-status', (req, res) => {
    const rawUserId = req.body.userId || req.body.id;
    const { status } = req.body;

    if (!rawUserId || rawUserId === 'undefined' || isNaN(Number(rawUserId))) {
        return res.status(400).json({ 
            success: false, 
            message: "Invalid or missing User ID. Please make sure the ID is passed correctly from Frontend." 
        });
    }

    const userId = parseInt(rawUserId, 10);

    const sql = "UPDATE users SET status = ? WHERE id = ?";
    db.query(sql, [status, userId], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "User not found or status already updated." });
        }

        res.json({ success: true, message: `Seller application ${status} successfully!` });
    });
});

// --- USER AUTHENTICATION & LOGIN ---

// ROUTE: SEND OTP
app.post('/send-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required!" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp, expires: Date.now() + 5 * 60 * 1000 };

    const mailOptions = {
        from: `"AgroTech" <${EMAIL_USER}>`,
        to: email,
        subject: 'AgroTech - Your OTP Verification Code',
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
            console.error("sendMail error | code:", err.code, "| message:", err.message);
            // Return the real error to the frontend for easier diagnosis
            return res.status(500).json({
                success: false,
                message: "OTP email failed: [" + (err.code || "ERR") + "] " + err.message
            });
        }
        console.log("OTP email sent to:", email, "| msgId:", info.messageId);
        res.json({ success: true, message: "OTP sent successfully to your email!" });
    });
});

// ROUTE: STANDALONE OTP VERIFY (used by seller flow before apply-seller)
app.post('/verify-otp', (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.json({ success: false, message: "Email and OTP required." });

    const entry = otpStore[email];
    if (!entry) return res.json({ success: false, message: "OTP not found. Please request a new one." });
    if (Date.now() > entry.expires) {
        delete otpStore[email];
        return res.json({ success: false, message: "OTP expired. Please request a new one." });
    }
    if (entry.otp !== otp) return res.json({ success: false, message: "Incorrect OTP. Please try again." });

    // Mark as verified (don't delete yet — apply-seller will consume it)
    otpStore[email].verified = true;
    res.json({ success: true, message: "OTP verified!" });
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
        db.query(insertSql, [username, email, password, role || 'farmer'], (err, result) => {
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

// FIXED: LOGIN ROUTE (RETURNS ROLE & STATUS PROPERLY)
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

            // Seller Approval Checks
            if (user.role === 'seller') {
                if (user.status === 'pending') {
                    return res.json({ success: false, message: "Your seller application is pending Admin approval! Please wait." });
                }
                if (user.status === 'rejected') {
                    return res.json({ success: false, message: "Your seller application was rejected by Admin." });
                }
            }

            // Successfully Return Role and User Details
            res.json({
                success: true,
                message: "Login successful!",
                user: { 
                    id: user.id, 
                    email: user.email, 
                    role: user.role, // 'seller', 'farmer', 'admin'
                    username: user.username,
                    status: user.status 
                }
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
                    user: { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status }
                });
            } else {
                const insertSql = "INSERT INTO users (username, email, role, password) VALUES (?, ?, ?, 'GOOGLE_AUTH')";
                db.query(insertSql, [name, email, role || 'farmer'], (err, result) => {
                    if (err) return res.status(500).json({ success: false, message: err.message });
                    res.json({
                        success: true,
                        message: "Registration successful",
                        user: { id: result.insertId, username: name, email: email, role: role || 'farmer', status: 'approved' }
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
    let sql = `SELECT p.*, u.company_name, u.username AS seller_name
               FROM products p
               LEFT JOIN users u ON p.admin_id = u.id`;
    let params = [];

    if (city !== 'All') {
        sql += " WHERE p.city = ?";
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

// ALIAS: /register maps to /register-user for frontend compatibility
app.post('/register', (req, res) => {
    const { username, email, password, role, phone } = req.body;

    const checkSql = "SELECT * FROM users WHERE email = ?";
    db.query(checkSql, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) return res.json({ success: false, message: "Email already registered!" });

        const insertSql = "INSERT INTO users (username, email, password, role, phone, status) VALUES (?, ?, ?, ?, ?, 'approved')";
        db.query(insertSql, [username, email, password, role || 'farmer', phone || null], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, message: "Account created successfully!" });
        });
    });
});

// ORDERS
app.post('/place-order', (req, res) => {
    const { user_id, product_id, name, address, phone, price } = req.body;
    const sql = "INSERT INTO orders (user_id, product_id, customer_name, address, phone) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [user_id, product_id, name, address, phone], (err, result) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true, message: "Order Placed!", orderId: result.insertId });
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
    const sql = `SELECT orders.*, products.name AS product_name, products.image, users.username AS buyer_name
                 FROM orders
                 LEFT JOIN products ON orders.product_id = products.id
                 LEFT JOIN users ON orders.user_id = users.id
                 ORDER BY orders.id DESC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, orders: results });
    });
});

// UPDATE ORDER STATUS
app.post('/update-order-status', (req, res) => {
    const { orderId, status } = req.body;
    if (!orderId || !status) return res.status(400).json({ success: false, message: "Missing orderId or status" });
    const sql = "UPDATE orders SET status = ? WHERE id = ?";
    db.query(sql, [status, orderId], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: `Order #${orderId} marked as ${status}` });
    });
});

// UPDATE PROFILE
// --- USER MANAGEMENT (seller dashboard) ---

// GET all farmers + sellers
app.get('/admin/users', (req, res) => {
    const sql = `SELECT id, username, email, phone, role, company_name, state, district, status, created_at
                 FROM users WHERE role IN ('farmer','seller') ORDER BY role, username`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, users: results });
    });
});

// DELETE a user by id
app.delete('/admin/user/:id', (req, res) => {
    db.query("DELETE FROM users WHERE id = ? AND role != 'admin'", [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, message: "User deleted successfully." });
    });
});

// EDIT a user's basic info
app.put('/admin/user/:id', (req, res) => {
    const { username, email, phone, company_name, status } = req.body;
    const sql = "UPDATE users SET username=?, email=?, phone=?, company_name=?, status=? WHERE id=? AND role != 'admin'";
    db.query(sql, [username, email, phone || null, company_name || null, status, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, message: "User updated successfully." });
    });
});

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