const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const bodyParser = require('body-parser');

const app = express();

// --- MYSQL CONNECTION ---
// --- CLOUD MYSQL CONNECTION (Aiven) ---
require('dotenv').config();

// 2. Connection details ko process.env se connect karein
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
    CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        role VARCHAR(50)
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
// Agar CORS use kar rahe ho
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Cloudinary Configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cloudinary ke sath Multer Storage setup
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'cityshop_products', // Cloudinary par is naam ka folder banega
        allowed_formats: ['jpg', 'png', 'jpeg'],
    },
});

const upload = multer({ storage: storage });
// --- ROUTES ---

// 1. REGISTER (Save to MySQL)
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

// 2. LOGIN (Check from MySQL)
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    const sql = "SELECT * FROM users WHERE email = ? AND password = ?";
    db.query(sql, [email, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (results.length > 0) {
            const user = results[0];
            res.json({
                success: true,
                user: { id: user.id,email: user.email, role: user.role, username: user.username }
            });
        } else {
            res.json({ success: false, message: "Invalid email or password!" });
        }
    });
});

// 3. ADD PRODUCT
// Is updated route ko use karein
app.post('/add-product', upload.single('image'), (req, res) => {
    console.log("Received Body:", req.body); // Check karein kya data aa raha hai
    console.log("Received File:", req.file);
    const { name, price, city, quantity, admin_id } = req.body; 
    const image = req.file ? req.file.filename : null;

    // Query mein admin_id add kiya gaya hai
    const sql = "INSERT INTO products (name, price, city, quantity, image, admin_id) VALUES (?, ?, ?, ?, ?, ?)";
    
    db.query(sql, [name, price, city, quantity, image, admin_id], (err, result) => {
        if (err) {
            console.error("Database Error:", err.message);
            return res.status(500).send("Database Error: " + err.message);
        }
        res.send("Product Added Successfully!");
    });
});
const PORT = process.env.PORT || 5000; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
// Products fetch karne ka route
app.get('/get-products', (req, res) => {
    const city = req.query.city || 'All';
    
    let sql = "SELECT * FROM products";
    let params = [];

    // 'All' ke alawa agar koi specific city aati hai toh ye chalega
    if (city !== 'All') {
        sql = "SELECT * FROM products WHERE city = ?"; // Yahan '?' lagana zaroori hai
        params = [city];
    }

    db.query(sql, params, (err, results) => {
        if (err) {
            console.error("Query Error:", err.message); // Console mein error check karein
            return res.status(500).json({ success: false, message: err.message });
        }
        res.json({ success: true, products: results });
        
    });
});
// --- ADMIN: VIEW OWN PRODUCTS ---
app.get('/admin-products/:adminId', (req, res) => {
    const sql = "SELECT * FROM products WHERE admin_id = ?";
    db.query(sql, [req.params.adminId], (err, results) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, products: results });
    });
});

// --- ADMIN: UPDATE PRODUCT ---



// --- USER: PLACE ORDER ---
app.post('/place-order', (req, res) => {
    const { user_id, product_id, name, address, phone } = req.body;
    const sql = "INSERT INTO orders (user_id, product_id, customer_name, address, phone) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [user_id, product_id, name, address, phone], (err, result) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, message: "Order Placed!" });
    });
});

// --- USER: GET MY ORDERS ---
// --- USER: GET MY ORDERS (Updated Fix) ---
app.get('/my-orders/:userId', (req, res) => {
    // JOIN query jisme products table se naam aur image li gayi hai
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

// --- USER: UPDATE PROFILE ---
app.put('/update-product/:id', upload.single('image'), (req, res) => {
    const productId = req.params.id;

    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).send("Form data empty!");
    }

    const { name, price, city, quantity } = req.body;

    if (req.file) {
        // Nayi image ka Cloudinary link
        const newImage = req.file.path; 

        // Seedha database update karo (Cloudinary se purani photo manually delete karne ki free tier me zaroorat nahi hai, storage kaafi hoti hai)
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=?, image=? WHERE id=?";
        const params = [name, price, city, quantity, newImage, productId];
        
        db.query(sql, params, (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated with new image on Cloudinary!");
        });
    } else {
        // Agar image change nahi karni hai
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=? WHERE id=?";
        const params = [name, price, city, quantity, productId];

        db.query(sql, params, (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated successfully!");
        });
    }
});

// Connection tutne par auto-reconnect karne ke liye handle karein
function handleDisconnect() {
    db.on('error', function(err) {
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.log('DB connection lost. Reconnecting...');
            // Yahan wapas se connection function chalayein
        } else {
            throw err;
        }
    });
}
handleDisconnect();
// 1. Saare orders fetch karne ke liye
app.get('/get-all-orders', (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).send(err);
        res.json(results);
    });
});

// 2. Order ka status update karne ke liye (Receive/Cancel/Deliver)
app.post('/add-product', upload.single('image'), (req, res) => {
    const { name, price, city, quantity, admin_id } = req.body; 
    
    // req.file.path mein Cloudinary ka permanent online link hota hai
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

// Product delete karne ka route
app.delete('/delete-product/:id', (req, res) => {
    const productId = req.params.id;

    // Pehle hum database se image ka naam nikalenge taaki use folder se bhi delete kar sakein
    const getImgSql = "SELECT image FROM products WHERE id = ?";
    
    db.query(getImgSql, [productId], (err, results) => {
        if (err) return res.status(500).send(err);

        if (results.length > 0) {
            const imageName = results[0].image;
            const fs = require('fs');
            const path = require('path');

            // Folder se image delete karna (Optional par acchi practice hai)
            const filePath = path.join(__dirname, 'uploads', imageName);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            // Ab database se product delete karenge
            const deleteSql = "DELETE FROM products WHERE id = ?";
            db.query(deleteSql, [productId], (err, result) => {
                if (err) return res.status(500).send(err);
                res.send("Product deleted successfully!");
            });
        } else {
            res.status(404).send("Product not found");
        }
    });
});

// 1. Specific product ka data lane ke liye (Edit form bharne ke liye)
app.get('/get-product/:id', (req, res) => {
    const sql = "SELECT * FROM products WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

// 2. Product update karne ka route
const fs = require('fs');


// Product update karne ka route (With Image)
// Product update karne ka route
app.put('/update-product/:id', upload.single('image'), (req, res) => {
    const productId = req.params.id;

    // Check if body is received
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).send("Form data empty! Check frontend headers.");
    }

    const { name, price, city, quantity } = req.body;

    if (req.file) {
        const newImage = req.file.filename;

        // Old image deletion logic
        db.query("SELECT image FROM products WHERE id = ?", [productId], (err, results) => {
            if (!err && results.length > 0 && results[0].image) {
                const oldImagePath = path.join(__dirname, 'uploads', results[0].image);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }

            const sql = "UPDATE products SET name=?, price=?, city=?, quantity=?, image=? WHERE id=?";
            const params = [name, price, city, quantity, newImage, productId];
            
            db.query(sql, params, (err, result) => {
                if (err) return res.status(500).send("DB Error: " + err.message);
                res.send("Product updated with new image!");
            });
        });
    } else {
        // Without image update
        const sql = "UPDATE products SET name=?, price=?, city=?, quantity=? WHERE id=?";
        const params = [name, price, city, quantity, productId];

        db.query(sql, params, (err, result) => {
            if (err) return res.status(500).send("DB Error: " + err.message);
            res.send("Product updated successfully!");
        });
    }
});
// Profile Update karne ka Route
app.put('/update-profile/:adminid', (req, res) => {
    const userId = req.params.adminid;
    const { username, email, phone, password } = req.body;

    // Agar password change karna hai toh query thodi alag hogi
    let sql = "UPDATE users SET username=?, email=?, phone=? WHERE id=?";
    let params = [username, email, phone, userId];

    if (password && password.trim() !== "") {
        sql = "UPDATE users SET username=?, email=?, phone=?, password=? WHERE id=?";
        params = [username, email, phone, password, userId];
    }

    db.query(sql, params, (err, result) => {
        if (err) return res.status(500).send(err);
        
        // Naya data fetch karke bhejenge taaki localStorage update ho sake
        db.query("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
            res.json({ message: "Profile Updated!", user: user[0] });
        });
    });
});