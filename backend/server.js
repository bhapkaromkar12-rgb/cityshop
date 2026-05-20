const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary'); // Cloudinary Storage Import
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
require('dotenv').config();

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

    // Automatic Table Creation Script
    const sql = `
    CREATE TABLE IF NOT EXISTS users (\r
        id INT AUTO_INCREMENT PRIMARY KEY,\r
        username VARCHAR(255),\r
        email VARCHAR(255) UNIQUE,\r
        password VARCHAR(255),\r
        role VARCHAR(50)\r
    );\r
    CREATE TABLE IF NOT EXISTS products (\r
        id INT AUTO_INCREMENT PRIMARY KEY,\r
        name VARCHAR(255),\r
        price DECIMAL(10,2),\r
        city VARCHAR(255),\r
        quantity INT,\r
        image VARCHAR(255),\r
        admin_id INT\r
    );\r
    CREATE TABLE IF NOT EXISTS orders (\r
        id INT AUTO_INCREMENT PRIMARY KEY,\r
        user_id INT,\r
        product_id INT,\r
        customer_name VARCHAR(255),\r
        address TEXT,\r
        phone VARCHAR(20),\r
        status VARCHAR(50) DEFAULT 'Pending',\r
        order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP\r
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
        folder: 'cityshop_products', // Cloudinary Dashboard par is naam ka folder banega
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
    },
});

const upload = multer({ storage: storage });

// --- ROUTES ---

// 1. REGISTER
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

// 2. LOGIN
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

// 3. ADD PRODUCT (Cloudinary Permanent URL Logic Fixed)
app.post('/add-product', upload.single('image'), (req, res) => {
    console.log("Received Body:", req.body);
    console.log("Received File:", req.file);
    const { name, price, city, quantity, admin_id } = req.body; 
    
    // Cloudinary ka permanent dynamic internet link yahan se milega
    const image = req.file ? req.file.path : null; 

    const sql = "INSERT INTO products (name, price, city, quantity, image, admin_id) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sql, [name, price, city, quantity, image, admin_id], (err, result) => {
        if (err) {
            console.error("Database Error:", err.message);
            return res.status(500).send("Database Error: " + err.message);
        }
        res.send("Product Added Successfully!");
    });
});

// 4. GET ALL PRODUCTS
app.get('/get-products', (req, res) => {
    const city = req.query.city || 'All';
    let sql = "SELECT * FROM products";
    let params = [];

    if (city !== 'All') {
        sql = "SELECT * FROM products WHERE city = ?";
        params = [city];
    }

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error("Query Error:", err.message);
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, products: results });
    });
});

// 5. ADMIN: VIEW OWN PRODUCTS
app.get('/admin-products/:adminId', (req, res) => {
    const sql = "SELECT * FROM products WHERE admin_id = ?";
    db.query(sql, [req.params.adminId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, products: results });
    });
});

// 6. GET SINGLE PRODUCT FOR EDITING
app.get('/get-product/:id', (req, res) => {
    const sql = "SELECT * FROM products WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

// 7. ADMIN: UPDATE PRODUCT (Cloudinary Storage Logic Fixed)
app.put('/update-product/:id', upload.single('image'), (req, res) => {
    const productId = req.params.id;

    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).send("Form data empty! Check frontend headers.");
    }

    const { name, price, city, quantity } = req.body;

    if (req.file) {
        // Cloudinary ka permanent internet link save hoga
        const newImage = req.file.path; 

        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=?, image=? WHERE id=?";
        const params = [name, price, city, quantity, newImage, productId];
        
        db.query(sql, params, (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated with new image on Cloudinary!");
        });
    } else {
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=? WHERE id=?";
        const params = [name, price, city, quantity, productId];

        db.query(sql, params, (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated successfully!");
        });
    }
});

// 8. DELETE PRODUCT
app.delete('/delete-product/:id', (req, res) => {
    const productId = req.params.id;
    const deleteSql = "DELETE FROM products WHERE id = ?";
    db.query(deleteSql, [productId], (err, result) => {
        if (err) return res.status(500).send(err);
        res.send("Product deleted successfully!");
    });
});

// 9. PLACE ORDER
app.post('/place-order', (req, res) => {
    const { user_id, product_id, name, address, phone } = req.body;
    const sql = "INSERT INTO orders (user_id, product_id, customer_name, address, phone) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [user_id, product_id, name, address, phone], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, message: "Order Placed!" });
    });
});

// 10. GET MY ORDERS
app.get('/my-orders/:userId', (req, res) => {
    const sql = `
        SELECT 
            orders.id, 
            orders.address, 
            orders.status, 
            orders.order_date,
            products.name AS product_name, 
            products.image, 
            products.price 
        FROM orders 
        JOIN products ON orders.product_id = products.id 
        WHERE orders.user_id = ? 
        ORDER BY orders.id DESC`;
        
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, orders: results });
    });
});

// 11. GET ALL ORDERS FOR ADMIN
app.get('/get-all-orders', (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// 12. UPDATE PROFILE
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