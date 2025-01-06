const { IgApiClient } = require('instagram-private-api');
const ig = new IgApiClient();
const db = require('./config/firebaseConfig');

// Fungsi penundaan acak
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = () => Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000; // Penundaan antara 1-3 detik

// Fungsi login
const login = async (username, password) => {
    ig.state.generateDevice(username);

    // Cek apakah sesi sudah ada di Firebase
    const userSessionRef = db.ref(`sessions/${username}`);
    const snapshot = await userSessionRef.once('value');
    const storedSessionData = snapshot.val();

    if (storedSessionData) {
        const sessionTimestamp = storedSessionData.timestamp;
        const currentTime = Date.now();
        
        // Cek apakah sesi sudah kadaluarsa (30 menit)
        if (currentTime - sessionTimestamp < 30 * 60 * 1000) {
            // Sesi masih valid, lanjutkan login
            ig.state.deserialize(storedSessionData.session);
            try {
                await ig.account.currentUser();
            } catch (error) {
                await forceLogin(username, password);
            }
        } else {
            // Sesi sudah expired, logout dan hapus sesi
            await logout(username);
            await forceLogin(username, password);
        }
    } else {
        await forceLogin(username, password);
    }
};

// Fungsi forceLogin
const forceLogin = async (username, password) => {
    try {
        // Tambahkan penundaan acak sebelum login
        await delay(randomDelay());

        await ig.account.login(username, password);
        const sessionData = ig.state.serialize();
        const currentTime = Date.now(); // Simpan waktu login saat ini

        // Simpan sessionData dan timestamp di Firebase
        await db.ref(`sessions/${username}`).set({
            session: sessionData,
            timestamp: currentTime, // Waktu login
        });

        console.log(`Login berhasil untuk ${username}`);
    } catch (error) {
        if (error.name === 'IgCheckpointError') {
            throw new Error('Instagram needs 2FA');
        } else {
            throw error;
        }
    }
};

// Fungsi logout
const logout = async (username) => {
    await db.ref(`sessions/${username}`).remove();
    console.log(`Logged out: ${username}`);
};

// API untuk profile
module.exports = async (req, res) => {
    const { method, url } = req;

    if (method === 'POST' && url === '/api/v1/instagram/login') {
        const { username, password } = req.body;
        try {
            await login(username, password);
            return res.status(200).json({ message: 'Login berhasil!' });
        } catch (error) {
            return res.status(400).json({ message: 'Login gagal: ' + error.message });
        }
    }

    if (method === 'GET' && url === '/api/v1/instagram/profile') {
        try {
            const user = await ig.account.currentUser();
            const followers = await fetchFollowers(user);
            const following = await fetchFollowing(user);
            const dontFollowBack = following.filter(f => !followers.find(follower => follower.username === f.username));

            return res.status(200).json({
                username: user.username,
                full_name: user.full_name,
                biography: user.biography,
                followers_count: user.follower_count,
                following_count: user.following_count,
                profile_picture_url: user.profile_pic_url,
                dont_follow_back_count: dontFollowBack.length,
                dont_follow_back: dontFollowBack.map(f => f.username),
            });
        } catch (error) {
            return res.status(400).json({ message: 'Error fetching profile: ' + error.message });
        }
    }

    return res.status(404).json({ message: 'Route tidak ditemukan' });
};

