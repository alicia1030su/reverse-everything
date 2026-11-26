import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Hardware from './pages/Hardware';
import NewProject from './pages/NewProject';
import TaskWorkbench, { TasksPage } from './pages/Tasks';
import Projects from './pages/Projects';
import Evidence from './pages/Evidence';
import Protocol from './pages/Protocol';
import Revival from './pages/Revival';
import Security from './pages/Security';
import Validation from './pages/Validation';
import Settings from './pages/Settings';
import Operations from './pages/Operations';
import ConsoleLab from './pages/ConsoleLab';
import Wizard from './pages/Wizard';
import Plans from './pages/Plans';
import Tools from './pages/Tools';
import Demos from './pages/Demos';
import Authorizations from './pages/Authorizations';
import Reports from './pages/Reports';

export default function App() {
  return <Routes><Route element={<Layout/>}>
    <Route index element={<Dashboard/>}/>
    <Route path="new" element={<NewProject/>}/>
    <Route path="hardware" element={<Hardware/>}/>
    <Route path="projects" element={<Projects/>}/>
    <Route path="projects/:id" element={<Projects/>}/>
    <Route path="tasks" element={<TasksPage/>}/>
    <Route path="tasks/:id" element={<TaskWorkbench/>}/>
    <Route path="evidence" element={<Evidence/>}/>
    <Route path="evidence/:taskId" element={<Evidence/>}/>
    <Route path="protocols" element={<Protocol/>}/>
    <Route path="protocols/:taskId" element={<Protocol/>}/>
    <Route path="revival" element={<Revival/>}/>
    <Route path="revival/:taskId" element={<Revival/>}/>
    <Route path="security" element={<Security/>}/>
    <Route path="validation" element={<Validation/>}/>
    <Route path="validation/:taskId" element={<Validation/>}/>
    <Route path="settings" element={<Settings/>}/>
    <Route path="operations" element={<Navigate to="/operations/system" replace/>}/>
    <Route path="operations/:section" element={<Operations/>}/>
    <Route path="wizard" element={<Wizard/>}/>
    <Route path="console-lab" element={<ConsoleLab/>}/>
    <Route path="console-lab/:projectId" element={<ConsoleLab/>}/>
    <Route path="plans" element={<Plans/>}/>
    <Route path="plans/:id" element={<Plans/>}/>
    <Route path="tools" element={<Tools/>}/>
    <Route path="demos" element={<Demos/>}/>
    <Route path="authorizations" element={<Authorizations/>}/>
    <Route path="reports" element={<Reports/>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Route></Routes>;
}
