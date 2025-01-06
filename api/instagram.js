const { IgApiClient } = require('instagram-private-api');
const ig = new IgApiClient();
let sessionData = null;

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

module.exports = async (req, res) => {
    const { method, url } = req;

    if (method === 'POST' && url === '/api/v1/instagram/login') {
        // Handle login request
        const { username, password } = req.body;
        try {
            await login(username, password);
            return res.status(200).json({ message: 'Login berhasil!' });
        } catch (error) {
            return res.status(400).json({ message: 'Login gagal: ' + error.message });
        }
    }

    if (method === 'GET' && url === '/api/v1/instagram/profile') {
        // Handle profile request
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

    // Jika route tidak dikenali
    return res.status(404).json({ message: 'Route tidak ditemukan' });
};
