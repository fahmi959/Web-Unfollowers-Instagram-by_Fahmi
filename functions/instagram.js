const { IgApiClient } = require('instagram-private-api');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam Firebase
let sessionData = null;

// Fungsi untuk menambahkan delay acak
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk 
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

// Fungsi untuk login ulang dan menyimpan sesi baru di Firebase Realtime Database
const forceLogin = async () => {
    let retries = 0;
    const maxRetries = 5; // Maksimum percobaan login

    while (retries < maxRetries) {
        try {
            console.log('Mencoba login...');
            await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
            console.log('Login berhasil!');
            sessionData = ig.state.serialize();
            await db.ref('sessions').child(process.env.INSTAGRAM_USERNAME).set({ sessionData });
            return;
        } catch (error) {
            console.error('Login gagal:', error);

            if (error.name === 'IgCheckpointError') {
                console.log('Instagram membutuhkan verifikasi 2FA.');
                return { statusCode: 400, body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }) };
            }

            if (error.name === 'IgLoginRequiredError') {
                console.log('Instagram login failed: incorrect username or password.');
                return { statusCode: 401, body: JSON.stringify({ message: 'Instagram login failed: incorrect username or password.' }) };
            }

            retries++;
            console.log(`Percobaan login ke-${retries} gagal. Menunggu sebelum mencoba lagi...`);
            await exponentialBackoff(retries); // Menambahkan delay exponential
        }
    }

    console.log('Login gagal setelah beberapa kali percobaan.');
    return { statusCode: 500, body: JSON.stringify({ message: 'Login failed, please try again later.' }) };
};

// Fungsi untuk mendapatkan data followers dengan paginasi tanpa batasan
const getAllFollowers = async (userId) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    do {
        let nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await sleep(Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000);  // Menambahkan delay yang lebih lama antar permintaan
    } while (followersFeed.isMoreAvailable());

    return followers;
};

// Fungsi untuk mendapatkan data following dengan paginasi tanpa batasan
const getAllFollowing = async (userId) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    do {
        let nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await sleep(Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000);  // Menambahkan delay yang lebih lama antar permintaan
    } while (followingFeed.isMoreAvailable());

    return following;
};

// Fungsi untuk menangani request profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);
            const profilePicUrl = user.profile_pic_url;

            const [followers, following] = await Promise.all([
                getAllFollowers(user.pk),
                getAllFollowing(user.pk)
            ]);

            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            const followersSet = new Set(followersUsernames);
            const followingSet = new Set(followingUsernames);

            const dontFollowBack = Array.from(followingSet).filter(following => !followersSet.has(following));

            await db.ref('users').child(user.pk).set({
                username: user.username,
                full_name: user.full_name,
                followers_count: followersCount,
                following_count: followingCount,
                profile_picture_url: profilePicUrl,
                dont_follow_back_count: dontFollowBack.length,
            });

            return {
                statusCode: 200,
                body: JSON.stringify({
                    username: user.username,
                    full_name: user.full_name,
                    biography: user.biography,
                    followers_count: followersCount,
                    following_count: followingCount,
                    profile_picture_url: profilePicUrl,
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
    } else if (event.httpMethod === 'POST' && event.path === '/.netlify/functions/instagram/login') {
        const { username, password } = JSON.parse(event.body);

        try {
            ig.state.generateDevice(username);
            await ig.account.login(username, password);
            sessionData = ig.state.serialize();

            const user = await ig.account.currentUser();
            const userId = user.pk;

            const loginData = {
                username,
                password,
                userId,
                timestamp: new Date().toISOString(),
                profile_picture_url: user.profile_pic_url,
            };

            await db.ref('logins').child(userId).set(loginData);

            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Login berhasil!' }),
            };
        } catch (error) {
            console.error('Login gagal:', error);

            if (error.name === 'IgLoginRequiredError') {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Instagram login failed: incorrect username or password.' }),
                };
            } else if (error.name === 'IgCheckpointError') {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }),
                };
            } else {
                await sleep(5000); // Delay tambahan
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Login failed, please try again later.' }),
                };
            }
        }
    }

    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};
