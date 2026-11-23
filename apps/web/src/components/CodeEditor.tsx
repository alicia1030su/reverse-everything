import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import '../../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js';
import '../../../../node_modules/monaco-editor/min/vs/editor/editor.main.css';
self.MonacoEnvironment={getWorker(){return new Worker(new URL('../../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js',import.meta.url),{type:'module'});}};
export default function CodeEditor({value}:{value:string}){const ref=useRef<HTMLDivElement>(null);const editor=useRef<monaco.editor.IStandaloneCodeEditor|undefined>();useEffect(()=>{if(!ref.current)return;editor.current=monaco.editor.create(ref.current,{value,language:'json',theme:'vs-dark',readOnly:true,automaticLayout:true,minimap:{enabled:false},fontSize:11,lineHeight:20,wordWrap:'on',scrollBeyondLastLine:false,renderLineHighlight:'none'});return()=>editor.current?.dispose();},[]);useEffect(()=>{if(editor.current&&editor.current.getValue()!==value)editor.current.setValue(value);},[value]);return <div ref={ref} className="h-full w-full"/>;}
