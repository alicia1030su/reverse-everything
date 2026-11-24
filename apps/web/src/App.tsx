import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import NewProject from './pages/NewProject';
import TaskWorkbench,{ TasksPage } from './pages/Tasks';
import Projects from './pages/Projects';
import Evidence from './pages/Evidence';
import Protocol from './pages/Protocol';
import Revival from './pages/Revival';
import Security from './pages/Security';
import Validation from './pages/Validation';
import Settings from './pages/Settings';
import Operations from './pages/Operations';
export default function App(){return <Routes><Route element={<Layout/>}><Route index element={<Dashboard/>}/><Route path="new" element={<NewProject/>}/><Route path="projects" element={<Projects/>}/><Route path="projects/:id" element={<Projects/>}/><Route path="tasks" element={<TasksPage/>}/><Route path="tasks/:id" element={<TaskWorkbench/>}/><Route path="evidence" element={<Evidence/>}/><Route path="evidence/:taskId" element={<Evidence/>}/><Route path="protocols" element={<Protocol/>}/><Route path="protocols/:taskId" element={<Protocol/>}/><Route path="revival" element={<Revival/>}/><Route path="revival/:taskId" element={<Revival/>}/><Route path="security" element={<Security/>}/><Route path="validation" element={<Validation/>}/><Route path="validation/:taskId" element={<Validation/>}/><Route path="settings" element={<Settings/>}/><Route path="operations/:section" element={<Operations/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Route></Routes>}
