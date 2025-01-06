const { IgApiClient } = require('instagram-private-api');
const express = require('express');
const router = express.Router();
const ig = new IgApiClient();

// Waktu pengaturan
let sessionData = null;

// Fungsi untuk login ke Instagram
const login = async (username, password) => {
    ig.state.generateDevice(username);

    if (sessionData) {
        ig.state.deserialize(sessionData);
        try {
            await ig.account.currentUser();
        } catch (error) {
            await forceLogin(username, password);
        }
    } else {
        await forceLogin(username, password);
    }
};

// Fungsi untuk login ulang dan menyimpan sesi baru di memori
const forceLogin = async (username, password) => {
    try {
        await ig.account.login(username, password);
        sessionData = ig.state.serialize();
    } catch (error) {
        if (error.name === 'IgCheckpointError') {
            throw new Error('Instagram needs 2FA');
        } else {
            throw error;
        }
    }
};

// Endpoint untuk login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        await login(username, password);
        res.json({ message: 'Login berhasil!' });
    } catch (error) {
        res.status(400).json({ message: 'Login gagal: ' + error.message });
    }
});

// Endpoint untuk mengambil profil Instagram
router.get('/profile', async (req, res) => {
    try {
        const user = await ig.account.currentUser();
        const followers = await ig.feed.accountFollowers(user.pk).items();
        const following = await ig.feed.accountFollowing(user.pk).items();

        const dontFollowBack = following.filter(f => !followers.find(follower => follower.username === f.username));

        res.json({
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
        res.status(400).json({ message: 'Error fetching profile: ' + error.message });
    }
});

module.exports = router;
