const { IgApiClient } = require('instagram-private-api');
const { db } = require('./config/firebaseConfig'); // Jika Anda tetap ingin menggunakan firebase untuk menyimpan data, jika tidak bisa dihapus
const ig = new IgApiClient();

let sessionData = null;

// Fungsi login
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);
    if (sessionData) {
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan, melanjutkan...');
        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.log('Sesi kadaluarsa, login ulang...');
            await forceLogin();
        }
    } else {
        console.log('Sesi tidak ditemukan, login ulang...');
        await forceLogin();
    }
};

// Fungsi login ulang dan simpan sesi baru
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        sessionData = ig.state.serialize(); 
    } catch (error) {
        console.error('Login gagal:', error);
        throw error;
    }
};

// Fungsi delay dinamis untuk menghindari spam
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk mengambil data followers dalam batch
const getFollowersUsernames = async (userId) => {
    let followersUsernames = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    while (followersFeed.isMoreAvailable()) {
        try {
            let nextFollowers = await followersFeed.items();
            if (nextFollowers && nextFollowers.length > 0) {
                followersUsernames = followersUsernames.concat(nextFollowers.map(f => f.username));
                // Mengatur delay acak antara 15 - 30 detik
                const delayTime = Math.random() * (30000 - 15000) + 15000;
                console.log(`Menunggu ${delayTime}ms untuk menghindari deteksi spam...`);
                await delay(delayTime);
            } else {
                break;
            }
        } catch (error) {
            console.error('Error fetching followers:', error);
            throw new Error('Failed to fetch followers.');
        }
    }
    console.log(`Jumlah followers: ${followersUsernames.length}`);
    return followersUsernames;
};

// Fungsi untuk mengambil data following dalam batch
const getFollowingUsernames = async (userId) => {
    let followingUsernames = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    while (followingFeed.isMoreAvailable()) {
        try {
            let nextFollowing = await followingFeed.items();
            if (nextFollowing && nextFollowing.length > 0) {
                followingUsernames = followingUsernames.concat(nextFollowing.map(f => f.username));
                // Mengatur delay acak antara 15 - 30 detik
                const delayTime = Math.random() * (30000 - 15000) + 15000;
                console.log(`Menunggu ${delayTime}ms untuk menghindari deteksi spam...`);
                await delay(delayTime);
            } else {
                break;
            }
        } catch (error) {
            console.error('Error fetching following:', error);
            throw new Error('Failed to fetch following.');
        }
    }
    console.log(`Jumlah following: ${followingUsernames.length}`);
    return followingUsernames;
};

// Fungsi untuk menangani permintaan profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            const followersUsernames = await getFollowersUsernames(user.pk);
            const followingUsernames = await getFollowingUsernames(user.pk);

            // Jika followers atau following kosong, log kesalahan
            if (followersUsernames.length === 0 || followingUsernames.length === 0) {
                console.error('Data followers atau following kosong.');
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Data followers atau following tidak ditemukan.' }),
                };
            }

            // Cari orang yang tidak follow back
            const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));

            return {
                statusCode: 200,
                body: JSON.stringify({
                    username: user.username,
                    full_name: user.full_name,
                    biography: user.biography,
                    followers_count: followersUsernames.length,
                    following_count: followingUsernames.length,
                    dont_follow_back: dontFollowBack,
                    dont_follow_back_count: dontFollowBack.length,
                }),
            };
        } catch (error) {
            console.error(error);
            if (error.name === 'IgLoginRequiredError') {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Login is required. Please check your credentials.' }),
                };
            } else {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Error fetching Instagram data' }),
                };
            }
        }
    }

    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};
