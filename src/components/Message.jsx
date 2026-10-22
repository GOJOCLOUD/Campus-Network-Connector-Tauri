import React, { useEffect } from 'react';

const Message = ({ message, onClose }) => {
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        onClose();
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [message, onClose]);

  if (!message) return null;

  return (
    <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-80 text-white text-sm py-1 px-3 rounded-lg shadow-lg z-50 pointer-events-none animate-fade-in-out">
      {message}
    </div>
  );
};

export default Message;