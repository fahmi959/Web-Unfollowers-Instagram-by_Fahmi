const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ig = new IgApiClient();
let sessionData = null;

// Waktu penundaan
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const login = async () => {
  ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);
  if (sessionData) {
    ig.state.deserialize(sessionData);
    try {
      await ig.account.currentUser();
    } catch (error) {
      await forceLogin();
    }
  } else {
    await forceLogin();
  }
};

const forceLogin = async () => {
  try {
    await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
    sessionData = ig.state.serialize();
  } catch (error) {
    throw error;
  }
};

const getProfileData = async () => {
  try {
    await login();
    const user = await ig.account.currentUser();
    const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
    const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

    const profilePicUrl = user.profile_pic_url;
    const imagePath = path.resolve(__dirname, '../public/my_profile.jpg');

    // Mengunduh gambar profil
    const writer = fs.createWriteStream(imagePath);
    const response = await axios.get(profilePicUrl, { responseType: 'stream' });
    response.data.pipe(writer);

    // Mengambil daftar followers dan following
    const followers = await ig.feed.accountFollowers(user.pk).items();
    const following = await ig.feed.accountFollowing(user.pk).items();

    const followersUsernames = followers.map(f => f.username);
    const followingUsernames = following.map(f => f.username);

    const followersSet = new Set(followersUsernames);
    const dontFollowBack = followingUsernames.filter(username => !followersSet.has(username));

    return {
      username: user.username,
      full_name: user.full_name,
      biography: user.biography,
      followers_count: followersCount,
      following_count: followingCount,
      profile_picture_url: '/my_profile.jpg',
      dont_follow_back: dontFollowBack,
      dont_follow_back_count: dontFollowBack.length,
    };
  } catch (error) {
    throw new Error('Error fetching Instagram data');
  }
};

module.exports = async (req, res) => {
  try {
    const data = await getProfileData();
    res.json(data);
  } catch (error) {
    res.status(500).send('Error fetching Instagram data');
  }
};
