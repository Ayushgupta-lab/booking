# MediCare Hospital — Appointment Booking Portal 🏥

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Ayushgupta-lab/booking)

A modern, responsive healthcare appointment booking web portal with patient authentication, live doctor scheduling, appointment management, and dual-database persistence (SQLite + MongoDB Atlas).

## 🚀 1-Click Deployment to Render

Click the button above or use this direct link:
👉 **[Deploy to Render](https://render.com/deploy?repo=https://github.com/Ayushgupta-lab/booking)**

### Environment Variables on Render
| Variable | Value | Description |
|---|---|---|
| `NODE_VERSION` | `22.12.0` | Required for native Node.js SQLite support |
| `MONGODB_URI` | `mongodb+srv://...` | Your MongoDB Atlas connection string |

## 🛠️ Features
- **Online Booking**: Real-time doctor slot selection and confirmation
- **Emergency Shifts**: Instant slot priority shifting
- **Dual Database**: High-speed local SQLite + cloud MongoDB Atlas synchronization
- **Modern Responsive UI**: Clean healthcare design system with mobile support

## 💻 Local Setup
```bash
# Install dependencies
npm install

# Start local server
npm start
```
Default local port: `http://localhost:3000`
