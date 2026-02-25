import express from 'express'; import cors from 'cors'; import previewRoutes from './routes/previewRoutes';
const app = express(); app.use(cors()); app.use(express.json({ limit: '50mb' })); app.use('/preview', previewRoutes);
const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log(`API on port ${PORT}`));
