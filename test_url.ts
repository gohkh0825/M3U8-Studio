import axios from 'axios';

async function testUrl() {
  const url = 'https://s1.fengbao9.com/video/dazhentandishiyiji/621cee96cef3/index.m3u8';
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    console.log('Status:', response.status);
    console.log('Headers:', response.headers);
    console.log('Body snippet:', response.data.substring(0, 500));
  } catch (error) {
    console.error('Error fetching URL:', error.message);
  }
}

testUrl();
