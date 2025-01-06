const { IgApiClient } = require('instagram-private-api');
const ig = new IgApiClient();
const db = require('./config/firebaseConfig');  // Mengimpor konfigurasi Firebase dari file firebaseConfig.js

// Fungsi untuk mengganti karakter tidak valid dalam username menjadi karakter yang valid di Firebase
const sanitizeUsername = (username) => {
    return username.replace(/[.#$[\]]/g, '_');  // Ganti karakter yang tidak valid dengan underscore
};

const login = async (username, password) => {
    const sanitizedUsername = sanitizeUsername(username);  // Sanitasi username

    ig.state.generateDevice(username);

    // Cek apakah sesi sudah ada di Firebase
    const userSessionRef = db.ref(`sessions/${sanitizedUsername}`);  // Menggunakan username yang sudah disanitasi
    const snapshot = await userSessionRef.once('value');
    const storedSessionData = snapshot.val();

    if (storedSessionData) {
        const sessionTimestamp = storedSessionData.timestamp;
        const currentTime = Date.now();
        
        // Cek apakah sesi sudah kadaluarsa (5 menit)
        if (currentTime - sessionTimestamp < 5 * 60 * 1000) {
            // Sesi masih valid, lanjutkan login
            ig.state.deserialize(storedSessionData.session);
            try {
                await ig.account.currentUser();
            } catch (error) {
                await forceLogin(username, password);
            }
        } else {
            // Sesi sudah expired, logout dan hapus sesi
            await logout(sanitizedUsername);
            await forceLogin(username, password);
        }
    } else {
        await forceLogin(username, password);
    }
};

const forceLogin = async (username, password) => {
    const sanitizedUsername = sanitizeUsername(username);  // Sanitasi username

    try {
        await ig.account.login(username, password);
        const sessionData = ig.state.serialize();
        const currentTime = Date.now(); // Simpan waktu login saat ini

        // Simpan sessionData dan timestamp di Firebase
        await db.ref(`sessions/${sanitizedUsername}`).set({
            session: sessionData,
            timestamp: currentTime, // Waktu login
        });
    } catch (error) {
        if (error.name === 'IgCheckpointError') {
            throw new Error('Instagram needs 2FA');
        } else {
            throw error;
        }
    }
};

const logout = async (username) => {
    const sanitizedUsername = sanitizeUsername(username);  // Sanitasi username

    // Hapus sesi pengguna di Firebase untuk memastikan login ulang
    await db.ref(`sessions/${sanitizedUsername}`).remove();
    // Anda bisa menambahkan kode untuk logout dari Instagram di sini
};

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
            const followers = await ig.feed.accountFollowers(user.pk).items();
            const following = await ig.feed.accountFollowing(user.pk).items();
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
